import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Returns the newest non-empty `field` of this session's `type` metadata rows.
 * Claude appends each as one small JSON line, so only lines containing the
 * quoted type are parsed instead of every message in a long transcript.
 */
function findNewestMetadataValue(
  content: string,
  sessionId: string,
  type: string,
  field: string,
): string | undefined {
  const marker = `"${type}"`;
  for (let index = content.lastIndexOf(marker); index >= 0;) {
    const start = content.lastIndexOf('\n', index) + 1;
    const end = content.indexOf('\n', index);
    let row: unknown;
    try {
      row = JSON.parse(content.slice(start, end < 0 ? undefined : end));
    } catch {
      // A partially written or unrelated line.
    }
    const data = row && typeof row === 'object' ? row as Record<string, unknown> : undefined;
    const value = data?.type === type && data.sessionId === sessionId ? data[field] : undefined;
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    index = start > 0 ? content.lastIndexOf(marker, start - 1) : -1;
  }
  return undefined;
}

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    // The upsert keeps the stored name when none is given, so an explicit
    // rename, or an automatic name written after this read, is never reverted.
    if (existingSession?.custom_name_source === 'user') {
      return parsed;
    }

    let content: string | undefined;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    // Like Claude Code, a native /rename outranks its generated title. Both
    // replace automatic names, including Codey's own generated title.
    const nativeTitle = content && (
      findNewestMetadataValue(content, parsed.sessionId, 'custom-title', 'customTitle')
      ?? findNewestMetadataValue(content, parsed.sessionId, 'ai-title', 'aiTitle')
    );
    if (nativeTitle) {
      return { ...parsed, sessionName: normalizeSessionName(nativeTitle, 'Untitled Claude Session') };
    }

    // The prompt fallbacks only name a session that has no name yet.
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return parsed;
    }

    const sessionName = nameMap.get(parsed.sessionId)
      || (content && findNewestMetadataValue(content, parsed.sessionId, 'last-prompt', 'lastPrompt'));

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName || undefined, 'Untitled Claude Session'),
    };
  }
}
