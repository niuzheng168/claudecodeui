import path from 'node:path';
import { access, readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { readCodexHistoryMode } from '@/modules/providers/list/codex/codex-thread-storage.repository.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  resolveCodexHomeDirectory,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

let daemonSyncInFlight: Promise<{ known: Set<string>; changed: string[] }> | null = null;

/**
 * Used by the Codex synchronizer and the provider watcher. Desktop threads may
 * exist in paginated storage before any JSONL is exported, so discover them
 * through the owning daemon as well as the legacy filesystem scan.
 */
export async function synchronizeCodexDaemonSessions(): Promise<{ known: Set<string>; changed: string[] }> {
  if (daemonSyncInFlight) return daemonSyncInFlight;
  daemonSyncInFlight = synchronizeDaemonIndex().finally(() => { daemonSyncInFlight = null; });
  return daemonSyncInFlight;
}

async function synchronizeDaemonIndex(): Promise<{ known: Set<string>; changed: string[] }> {
  const known = new Set<string>();
  const changed: string[] = [];
  const client = await CodexDaemonClient.connect();
  if (!client) return { known, changed };
  try {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const result = await client.request('thread/list', {
        limit: 100,
        ...(cursor ? { cursor } : {}),
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
        archived: false,
        sortKey: 'updated_at',
        useStateDbOnly: true,
      });
      for (const thread of Array.isArray(result.data) ? result.data : []) {
        if (typeof thread?.id !== 'string' || typeof thread.cwd !== 'string' || !thread.cwd) continue;
        if (sessionsDb.isProviderSessionSuperseded(thread.id, 'codex')) continue;
        known.add(thread.id);
        const existing = sessionsDb.getSessionByProviderSessionId(thread.id);
        // Polling is not an instruction to undo the user's local archive.
        if (existing?.isArchived) continue;
        const nativeName = typeof thread.name === 'string' && thread.name.trim()
          ? normalizeSessionName(thread.name, 'Untitled Codex Session')
          : existing?.custom_name || 'Untitled Codex Session';
        const name = existing?.custom_name && existing.custom_name !== 'Untitled Codex Session'
          ? existing.custom_name : nativeName;
        const createdAt = new Date(Number(thread.createdAt || 0) * 1000).toISOString();
        const updatedAt = new Date(Number(thread.updatedAt || thread.createdAt || 0) * 1000).toISOString();
        let transcriptPath: string | null = typeof thread.path === 'string' && thread.path ? thread.path : null;
        if (transcriptPath) {
          try { await access(transcriptPath); } catch { transcriptPath = null; }
        }
        // A removed legacy rollout can leave a stale state-db row behind.
        // Native paginated threads, unlike legacy ones, need no export.
        if (!transcriptPath && await readCodexHistoryMode(thread.id) === 'legacy') continue;
        if (existing && existing.updated_at === updatedAt && existing.custom_name === name
          && existing.jsonl_path === transcriptPath && existing.project_path === thread.cwd && !existing.isArchived) {
          continue;
        }
        changed.push(sessionsDb.createSession(
          thread.id, 'codex', thread.cwd, name, createdAt, updatedAt, transcriptPath,
        ));
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (cursor && seenCursors.has(cursor)) throw new Error('Codex repeated a thread-list cursor.');
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return { known, changed };
  } finally {
    client.close();
  }
}

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private get codexHome(): string {
    return resolveCodexHomeDirectory();
  }

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    let nativeIds = new Set<string>();
    try {
      nativeIds = (await synchronizeCodexDaemonSessions()).known;
    } catch (error) {
      // Preserve CLI-only discovery when a desktop daemon cannot be reached.
      // Its index is retried independently, without the JSONL birthtime cursor.
      console.warn('[Codex] Desktop session discovery unavailable:', error instanceof Error ? error.message : String(error));
    }
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = nativeIds.size;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed || nativeIds.has(parsed.sessionId)) {
        continue;
      }

      const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existingSession) {
        // If session name is untitled and we now have a name, update it
        if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
          sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName);
        }
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
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
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
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(parsed.sessionId, this.provider)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    if (existingSession?.isArchived) return null;
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
