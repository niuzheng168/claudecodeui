import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { claudeDesktopArchiveDb, sessionsDb, memoryArchiveDb } from '@/modules/database/index.js';
import type { PendingClaudeDesktopArchive } from '@/modules/database/index.js';
import { readLastMessageTime } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { broadcastSessionsArchived, broadcastSessionUpsertedBatch } from '@/modules/websocket/index.js';

/** One Claude Code session as a Claude Desktop record on this computer describes it. */
type DesktopSession = PendingClaudeDesktopArchive & {
  /** Desktop runs it on another machine over SSH, so its transcript and that machine's Codey index are there. */
  remote: boolean;
  /** The session the record runs now, as opposed to one it ran before. */
  current: boolean;
};

/** An archive or restore to apply to a Claude session, by Claude Code's session id. */
export type ClaudeArchiveChange = {
  providerSessionId: string;
  archived: boolean;
  /**
   * The archiving side's last activity in the session, ms since the epoch. A
   * session with messages after it was continued elsewhere and is not archived.
   */
  lastActivityAt: number | null;
};

/** What applying changes found on this computer. */
export type ClaudeArchiveResult = {
  /** Per change: the session's app id here, or null when this computer does not list it. */
  sessions: Array<{ providerSessionId: string; sessionId: string | null }>;
  archived: string[];
  restored: string[];
};

/** The codey package's signed request to the Portal as this node (packages/codey/lib/session-messages.mjs). */
type PortalRequest = (method: string, pathname: string, options: { body?: unknown }) => Promise<unknown>;

// Claude Desktop's data folder is `Claude-3p` when it uses a third-party
// gateway, as on Codey's machines, and `Claude` when it signs in to claude.ai.
const DESKTOP_FOLDER_NAMES = ['Claude-3p', 'Claude'];
// Inside it: claude-code-sessions/<account>/<organization>/local_<id>.json.
const SESSIONS_FOLDER = 'claude-code-sessions';
const RECORD_FILE = /^local_[\w-]+\.json$/;
// Messages this much later than Desktop's last activity mean the session went on outside Desktop;
// less is the two machines' clocks disagreeing.
const CONTINUED_AFTER_MS = 2 * 60_000;
// The Portal takes at most this many sessions per request.
const PASS_ON_BATCH = 100;
const PASS_ON_RETRY_MS = { first: 5 * 60_000, longest: 60 * 60_000 };

// Records already parsed, by path, until their modification time changes.
const parsedRecords = new Map<string, { mtimeMs: number; sessions: DesktopSession[] }>();
let portalRequest: Promise<PortalRequest | null> | null = null;
const passOnRetry = { at: 0, delayMs: PASS_ON_RETRY_MS.first };

async function listEntries(folder: string, kind: 'file' | 'directory'): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => (kind === 'file' ? entry.isFile() : entry.isDirectory())).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Where Claude Desktop may keep its data on this computer. The Microsoft
 * Store build may keep it in its package folder instead of AppData itself.
 */
async function desktopDataFolders(): Promise<string[]> {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return DESKTOP_FOLDER_NAMES.map((name) => path.join(home, 'Library', 'Application Support', name));
  }
  if (process.platform !== 'win32') {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return DESKTOP_FOLDER_NAMES.map((name) => path.join(config, name));
  }
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const bases = [local, roaming];
  for (const name of await listEntries(path.join(local, 'Packages'), 'directory')) {
    if (name.startsWith('Claude_')) {
      bases.push(path.join(local, 'Packages', name, 'LocalCache', 'Local'), path.join(local, 'Packages', name, 'LocalCache', 'Roaming'));
    }
  }
  return bases.flatMap((base) => DESKTOP_FOLDER_NAMES.map((name) => path.join(base, name)));
}

const readSessionId = (value: unknown): string | null => (typeof value === 'string' && /^[\w-]+$/.test(value) ? value : null);

/**
 * The Claude Code sessions one Desktop record names: the one it runs now
 * (`cliSessionId`) and any Desktop moved it off (`priorRemoteCliSessionIds`),
 * which Codey lists as sessions of their own. Null for a file that is not a
 * session record, or one caught while Desktop rewrites it.
 */
function parseDesktopRecord(text: string): DesktopSession[] | null {
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const current = readSessionId(record.cliSessionId);
  if (!current) return null;
  const prior = record.priorRemoteCliSessionIds;
  const earlier = (Array.isArray(prior) ? prior : [prior]).map(readSessionId)
    .filter((id): id is string => Boolean(id) && id !== current);
  const ssh = record.sshConfig as { sshHost?: unknown } | null | undefined;
  const remote = typeof ssh?.sshHost === 'string' && ssh.sshHost.length > 0;
  const archived = record.isArchived === true;
  const desktopActivityAt = Number.isSafeInteger(record.lastActivityAt) ? record.lastActivityAt as number : null;
  return [current, ...new Set(earlier)].map((providerSessionId) => ({
    providerSessionId, archived, desktopActivityAt, remote, current: providerSessionId === current,
  }));
}

/**
 * Every Claude Code session a Claude Desktop record on this computer names,
 * once each. A record's current session outranks another record's mention of
 * it as an earlier one. Each pass stats the records and parses only those
 * that changed. `folders` overrides where Desktop's data is looked for.
 */
async function readClaudeDesktopSessions(folders?: string[]): Promise<DesktopSession[]> {
  const sessions = new Map<string, DesktopSession>();
  const seen = new Set<string>();
  for (const folder of folders ?? await desktopDataFolders()) {
    const root = path.join(folder, SESSIONS_FOLDER);
    for (const account of await listEntries(root, 'directory')) {
      for (const organization of await listEntries(path.join(root, account), 'directory')) {
        const directory = path.join(root, account, organization);
        for (const name of (await listEntries(directory, 'file')).sort()) {
          if (!RECORD_FILE.test(name)) continue;
          const file = path.join(directory, name);
          seen.add(file);
          let cached = parsedRecords.get(file);
          try {
            const { mtimeMs } = await stat(file);
            if (cached?.mtimeMs !== mtimeMs) {
              const parsed = parseDesktopRecord(await readFile(file, 'utf8'));
              // One caught mid-write keeps what was read before, and is read again next pass.
              if (parsed) {
                cached = { mtimeMs, sessions: parsed };
                parsedRecords.set(file, cached);
              }
            }
          } catch {
            // Removed or replaced between listing and reading.
            continue;
          }
          for (const session of cached?.sessions ?? []) {
            const other = sessions.get(session.providerSessionId);
            if (!other || (session.current && !other.current)) sessions.set(session.providerSessionId, session);
          }
        }
      }
    }
  }
  for (const file of parsedRecords.keys()) {
    if (!seen.has(file)) parsedRecords.delete(file);
  }
  return [...sessions.values()];
}

/**
 * Whether the session has messages from well after `lastActivityAt`. Read
 * from the transcript: the date in the index may still be the file's
 * modification time, from before dates came from messages.
 */
async function continuedAfter(row: { jsonl_path: string | null; updated_at: string }, lastActivityAt: number): Promise<boolean> {
  const lastMessageAt = Date.parse((row.jsonl_path ? await readLastMessageTime(row.jsonl_path) : undefined) ?? row.updated_at);
  return lastMessageAt > lastActivityAt + CONTINUED_AFTER_MS;
}

/**
 * Archives or restores Claude sessions this computer lists, by Claude Code's
 * session id, and tells open sidebars. An archive leaves a session alone when
 * it has messages from after the archiving side's last activity: the user
 * went on with it in Codey (or a terminal) and only put it away over there.
 *
 * Used by the Claude Desktop archive sync on this computer, and by
 * `/api/codey/v1/sessions/archive` (session-messages module) for an archive
 * Claude Desktop made on another of the owner's machines.
 */
export async function applyClaudeArchiveChanges(changes: ClaudeArchiveChange[]): Promise<ClaudeArchiveResult> {
  const result: ClaudeArchiveResult = { sessions: [], archived: [], restored: [] };
  for (const change of changes) {
    const row = sessionsDb.getSessionByProviderSessionId(change.providerSessionId)
      ?? sessionsDb.getSessionById(change.providerSessionId);
    if (!row || row.provider !== 'claude') {
      result.sessions.push({ providerSessionId: change.providerSessionId, sessionId: null });
      continue;
    }
    result.sessions.push({ providerSessionId: change.providerSessionId, sessionId: row.session_id });
    if (Boolean(row.isArchived) === change.archived) continue;
    if (change.archived && change.lastActivityAt !== null && await continuedAfter(row, change.lastActivityAt)) continue;
    sessionsDb.updateSessionIsArchived(row.session_id, change.archived);
    (change.archived ? result.archived : result.restored).push(row.session_id);
  }
  broadcastSessionsArchived(result.archived);
  // A sidebar that misses a restored session finds it on its next refresh.
  await broadcastSessionUpsertedBatch(result.restored).catch(() => undefined);
  return result;
}

/**
 * Carries Claude Desktop's archive on this computer into Codey. Archiving a
 * session in Desktop ends its process and hides it there, but its transcript
 * stays, so Codey went on listing it.
 *
 * Only changes are carried: a session first seen archived, or one Desktop
 * archived or restored since the last pass. A session the user brings back
 * in Codey stays back until Desktop changes it again. Codey's own archive is
 * not written back to Desktop.
 *
 * The change applies to this computer's index, which holds the transcript of
 * a session Desktop runs here and the copy Desktop keeps of one it runs on
 * another machine over SSH. For the latter the change also waits to be passed
 * on to that machine (passOnClaudeDesktopArchive); `passOn` says one was added.
 *
 * Used by the sessions watcher, which polls it.
 * @param folders - Where Desktop's data is looked for; tests override it
 */
export async function synchronizeClaudeDesktopArchive(
  folders?: string[],
): Promise<Pick<ClaudeArchiveResult, 'archived' | 'restored'> & { passOn: boolean }> {
  const changed: DesktopSession[] = [];
  for (const session of await readClaudeDesktopSessions(folders)) {
    // The local Desktop copy of an SSH conversation is not its material source.
    // This metadata does not initialize the archive outbox or backfill old sessions.
    memoryArchiveDb.setMirror('claude',session.providerSessionId,session.remote);
    const known = claudeDesktopArchiveDb.get(session.providerSessionId);
    if (process.env.CODEY_PORTAL_CLIENT_MODULE && memoryArchiveDb.started()) {
      memoryArchiveDb.observeNative('claude',session.providerSessionId,session.archived,!known,undefined,String(session.desktopActivityAt ?? ''),false);
    }
    if (known?.archived === session.archived) continue;
    // First seen in use: nothing to carry over, and Codey's own archive stays.
    const carried = Boolean(known) || session.archived;
    claudeDesktopArchiveDb.set(session, carried && session.remote);
    if (carried) changed.push(session);
  }
  const { archived, restored } = await applyClaudeArchiveChanges(changed.map((session) => ({
    providerSessionId: session.providerSessionId,
    archived: session.archived,
    lastActivityAt: session.desktopActivityAt,
  })));
  return { archived, restored, passOn: changed.some((session) => session.remote) };
}

/**
 * The codey package's signed Portal request, when CloudCLI runs inside an
 * installed Codey node: the package names its module in
 * CODEY_PORTAL_CLIENT_MODULE (packages/codey/lib/workspace.mjs).
 */
function loadPortalRequest(): Promise<PortalRequest | null> {
  portalRequest ??= (async () => {
    const modulePath = process.env.CODEY_PORTAL_CLIENT_MODULE;
    if (!modulePath) return null;
    try {
      const loaded = await import(pathToFileURL(modulePath).href) as { portalRequest?: unknown };
      return typeof loaded.portalRequest === 'function' ? loaded.portalRequest as PortalRequest : null;
    } catch (error) {
      console.warn('[Claude] Cannot load the Codey Portal client:', error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  return portalRequest;
}

/** The Portal's answer to `POST /api/v1/sessions/archive`: who lists each session, and who could not be asked. */
function readPassOnAnswer(answer: unknown): { listed: Set<string>; complete: boolean } {
  const body = (answer ?? {}) as { sessions?: unknown; unreachable?: unknown };
  const listed = new Set<string>();
  for (const session of Array.isArray(body.sessions) ? body.sessions : []) {
    const entry = session as { sessionId?: unknown; machines?: unknown };
    if (typeof entry.sessionId === 'string' && Array.isArray(entry.machines) && entry.machines.length) listed.add(entry.sessionId);
  }
  return { listed, complete: Array.isArray(body.unreachable) && body.unreachable.length === 0 };
}

/**
 * Passes Desktop's changes to sessions it runs on another machine over SSH to
 * the Portal, which applies each on whichever of the owner's other machines
 * lists it (`POST /api/v1/sessions/archive`, docs/codey-api-v1.md). A change
 * is done once some machine listed the session, or every machine answered and
 * none did (its host is not a Codey node). Otherwise it is tried again later,
 * sooner when Desktop makes a new change (`immediately`).
 *
 * Used by the sessions watcher after each synchronizeClaudeDesktopArchive.
 * @param options.request - The signed Portal request; tests pass a fake
 */
export async function passOnClaudeDesktopArchive(
  { immediately = false, request, now = Date.now() }: { immediately?: boolean; request?: PortalRequest | null; now?: number } = {},
): Promise<void> {
  const pending = claudeDesktopArchiveDb.listPending();
  if (!pending.length || (!immediately && now < passOnRetry.at)) return;
  const send = request === undefined ? await loadPortalRequest() : request;
  if (!send) return;
  try {
    for (let start = 0; start < pending.length; start += PASS_ON_BATCH) {
      const batch = pending.slice(start, start + PASS_ON_BATCH);
      const answer = readPassOnAnswer(await send('POST', '/api/v1/sessions/archive', {
        body: {
          sessions: batch.map((change) => ({
            provider: 'claude',
            sessionId: change.providerSessionId,
            archived: change.archived,
            ...(change.desktopActivityAt === null ? {} : { lastActivityAt: new Date(change.desktopActivityAt).toISOString() }),
          })),
        },
      }));
      for (const change of batch) {
        if (answer.complete || answer.listed.has(change.providerSessionId)) {
          claudeDesktopArchiveDb.clearPending(change.providerSessionId, change.archived);
        }
      }
    }
  } catch (error) {
    console.warn('[Claude] Could not pass Claude Desktop archive changes on:', error instanceof Error ? error.message : String(error));
  }
  if (claudeDesktopArchiveDb.listPending().length) {
    passOnRetry.at = now + passOnRetry.delayMs;
    passOnRetry.delayMs = Math.min(passOnRetry.delayMs * 2, PASS_ON_RETRY_MS.longest);
  } else {
    Object.assign(passOnRetry, { at: 0, delayMs: PASS_ON_RETRY_MS.first });
  }
}
