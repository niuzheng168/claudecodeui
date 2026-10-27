import os from 'node:os';
import path from 'node:path';
import { open, readFile } from 'node:fs/promises';

import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
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

// The longest transcript tail read to find the session's last message.
const LAST_MESSAGE_TAIL_BYTES = 1024 * 1024;
// `app_config` key set once the sessions indexed before dates came from
// messages have been re-dated (see redateIndexedSessions).
const REDATED_BY_LAST_MESSAGE_KEY = 'claude_sessions_redated_by_last_message';

/**
 * When the session last had a message: the `timestamp` of the transcript's
 * newest user or assistant row, as an ISO string. Claude Code also appends
 * rows when nothing is said: titles, the last prompt, the mode, and the cost
 * so far as its process exits. Claude Desktop ends that process when its user
 * archives the session there. Dated by the file instead, a session archived
 * days after its last message would turn recent, and the newer date would undo
 * an archive made in Codey (`sessionsDb.createSession`).
 * Undefined when the tail holds no message, such as a transcript with only
 * metadata so far; the file's modification time stands in then.
 */
async function readLastMessageTime(filePath: string): Promise<string | undefined> {
  let tail: string;
  let partialFirstLine: boolean;
  try {
    const file = await open(filePath, 'r');
    try {
      const { size } = await file.stat();
      const length = Math.min(size, LAST_MESSAGE_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, size - length);
      tail = buffer.subarray(0, bytesRead).toString('utf8');
      partialFirstLine = length < size;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }

  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= (partialFirstLine ? 1 : 0); index -= 1) {
    let row: unknown;
    try {
      row = JSON.parse(lines[index]);
    } catch {
      // A line still being written, or not JSON.
      continue;
    }
    const data = row && typeof row === 'object' ? row as Record<string, unknown> : undefined;
    if (data?.type !== 'user' && data?.type !== 'assistant') {
      continue;
    }
    const time = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : Number.NaN;
    if (Number.isFinite(time)) {
      return new Date(time).toISOString();
    }
  }
  return undefined;
}

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

      const timestamps = await this.readSessionTimestamps(filePath);
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

    if (!appConfigDb.get(REDATED_BY_LAST_MESSAGE_KEY)) {
      await this.redateIndexedSessions();
      appConfigDb.set(REDATED_BY_LAST_MESSAGE_KEY, new Date().toISOString());
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

    const timestamps = await this.readSessionTimestamps(filePath);
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
   * A session is created with its transcript file and updated at its last
   * message (see readLastMessageTime).
   */
  private async readSessionTimestamps(filePath: string): Promise<{ createdAt?: string; updatedAt?: string }> {
    const timestamps = await readFileTimestamps(filePath);
    return {
      createdAt: timestamps.createdAt,
      updatedAt: (await readLastMessageTime(filePath)) ?? timestamps.updatedAt,
    };
  }

  /**
   * Sessions indexed before dates came from messages carry their transcript's
   * modification time, which an exiting process can move days past the last
   * message. Scans index only transcripts created since the previous scan, and
   * the watcher only those that change, so a transcript that stays as it is
   * would keep that date; each session is moved back to its last message once
   * here. Only the date changes: indexing the transcript again would also
   * restore an archived project (`projectsDb.createProjectPath`).
   */
  private async redateIndexedSessions(): Promise<void> {
    for (const session of sessionsDb.getSessionsWithTranscriptPath()) {
      if (session.provider !== this.provider) {
        continue;
      }
      const lastMessageAt = await readLastMessageTime(session.jsonl_path);
      if (lastMessageAt) {
        sessionsDb.moveSessionUpdatedAtBack(session.session_id, lastMessageAt);
      }
    }
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
