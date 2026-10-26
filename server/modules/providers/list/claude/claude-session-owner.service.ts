import { open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The entrypoint every Claude Code process Codey launches registers with: the
 * Agent SDK's. The Claude runtime (claude-runtime.provider.js) pins it in the
 * launch environment, so a Codey node started from a Claude Desktop or
 * terminal shell cannot inherit theirs and mistake its own processes for them.
 * The CLI liveness check (claude-cli-liveness.service.ts) skips these
 * processes for the same reason: the runtime reports them itself.
 */
export const CODEY_CLAUDE_ENTRYPOINT = 'sdk-ts';

// The longest transcript tail read to find the last process that wrote a turn.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
// Claude Code shortens (and hashes) longer project folder names.
const MAX_PROJECT_FOLDER_LENGTH = 200;
// How often a process that was asked to exit is checked for having done so.
const EXIT_POLL_MS = 100;
// How often a turn another process runs is checked for new rows and its end.
const FOLLOW_POLL_MS = 300;

type ForeignSessionProcess = {
  pid: number;
  entrypoint: string;
  /** Where the process takes messages from other sessions; absent before Claude Code 2.1.2xx. */
  messagingSocketPath: string | null;
  cwd: string | null;
  /** `/proc/<pid>/stat` field 22 as registered, which tells the process from a later one with its pid. */
  procStart: string | null;
  /** `interactive` for Claude Desktop, terminals and SDK hosts; `bg` or `daemon` for background sessions. */
  kind: string | null;
  /** The status registered when it was found; see readForeignSessionStatus. */
  status: ForeignSessionStatus;
};

/**
 * What a process that had the session open is doing: running a turn (`busy`),
 * waiting for its own user to answer a prompt (`waiting`), between turns
 * (`idle`), or no longer holding the session because it exited or moved on to
 * another one (`gone`). Null when its registration could not be read just now.
 */
type ForeignSessionStatus = 'idle' | 'busy' | 'waiting' | 'gone' | null;

const claudeHome = (): string => path.join(os.homedir(), '.claude');
const registrationsDirectory = (): string => path.join(claudeHome(), 'sessions');

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just is not ours to signal.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Whether a registration's process start time no longer matches the process
 * now holding its pid, i.e. the registered process died and the pid was
 * reused. Claude Code records `/proc/<pid>/stat` field 22; where there is no
 * procfs the pid alone has to do.
 */
async function isReusedPid(pid: number, procStart: unknown): Promise<boolean> {
  if (typeof procStart !== 'string') {
    return false;
  }
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return false;
  }
  // The command name is parenthesised and may contain spaces; field 3 follows it.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[22 - 3] !== procStart;
}

async function isLive(pid: number, procStart: unknown): Promise<boolean> {
  return isRunning(pid) && !(await isReusedPid(pid, procStart));
}

const readString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A registration file's record, or null while it is being written or removed. */
async function readRegistration(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const record = JSON.parse(await readFile(filePath, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

/** The status a registration reports; Claude Code builds that predate it count as between turns. */
function readRegisteredStatus(record: Record<string, unknown>): 'idle' | 'busy' | 'waiting' {
  return record.status === 'busy' || record.status === 'waiting' ? record.status : 'idle';
}

/** The registered process, unless Codey launched it or the record names no usable pid. */
function readForeignRegistration(record: Record<string, unknown>): ForeignSessionProcess | null {
  const entrypoint = readString(record.entrypoint) ?? 'unknown';
  const pid = Number(record.pid);
  if (entrypoint === CODEY_CLAUDE_ENTRYPOINT || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    entrypoint,
    messagingSocketPath: readString(record.messagingSocketPath),
    cwd: readString(record.cwd),
    procStart: readString(record.procStart),
    kind: readString(record.kind),
    status: readRegisteredStatus(record),
  };
}

/**
 * Finds a live Claude Code process outside Codey that has the session open —
 * Claude Desktop, or `claude --resume` in a terminal. Every interactive Claude
 * Code process registers itself in `~/.claude/sessions/<pid>.json` until it
 * exits. A turn Codey started for the same session would be a second process
 * continuing it: neither sees the other's turns, and the transcript forks.
 *
 * Used by the Claude runtime (claude-runtime.provider.js) before it resumes a
 * session and to follow a turn such a process runs, and by session messages
 * (session-message-delivery.service.ts) to reach it.
 * @param providerSessionId - Claude Code's session id
 * @returns The first such process, or null when no other process has it open
 */
export async function findForeignSessionProcess(providerSessionId: string): Promise<ForeignSessionProcess | null> {
  const directory = registrationsDirectory();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }

  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    const record = await readRegistration(path.join(directory, name));
    if (record?.sessionId !== providerSessionId) {
      continue;
    }
    const owner = readForeignRegistration(record);
    if (owner && await isLive(owner.pid, owner.procStart)) {
      return owner;
    }
  }
  return null;
}

/**
 * Whether the process is Claude Desktop's, local or over SSH. Desktop starts
 * its process again, resuming the session, when its user next opens it, so
 * Codey continues an idle Desktop session without asking.
 *
 * Used by the Claude runtime (claude-runtime.provider.js) to decide whether
 * taking a session over needs the user's confirmation.
 */
export function isClaudeDesktopProcess(owner: ForeignSessionProcess): boolean {
  return owner.entrypoint.startsWith('claude-desktop');
}

/**
 * What the process is doing now, read again from its registration rather
 * than trusted from when it was found: Claude Code rewrites it as each turn
 * starts and ends.
 *
 * Used by the Claude runtime (claude-runtime.provider.js) right before it
 * ends the process, and while it follows a turn the process runs.
 */
export async function readForeignSessionStatus(
  owner: ForeignSessionProcess,
  providerSessionId: string,
): Promise<ForeignSessionStatus> {
  if (!(await isLive(owner.pid, owner.procStart))) {
    return 'gone';
  }
  const record = await readRegistration(path.join(registrationsDirectory(), `${owner.pid}.json`));
  if (!record) {
    return null;
  }
  // `/clear` or `/resume` in that process moved it to another session.
  return record.sessionId === providerSessionId ? readRegisteredStatus(record) : 'gone';
}

/**
 * Asks the process to exit and waits until it has, so Codey can continue the
 * session without a second writer. Between turns, SIGTERM ends Claude Code
 * cleanly: nothing is being written, and it removes its registration.
 *
 * Used by the Claude runtime (claude-runtime.provider.js) to take a session over.
 * @returns False when the process could not be signalled or outlived the wait
 */
export async function endForeignSessionProcess(owner: ForeignSessionProcess, timeoutMs: number): Promise<boolean> {
  if (!(await signalForeignSessionProcess(owner, 'SIGTERM'))) {
    return !(await isLive(owner.pid, owner.procStart));
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    if (!(await isLive(owner.pid, owner.procStart))) {
      return true;
    }
  }
  return false;
}

/**
 * Sends the process a signal, unless its pid now belongs to another process.
 * SIGINT stops the turn it is running the way Ctrl+C does and keeps what was
 * already written; Claude Desktop's process then exits, a terminal's waits for
 * its user. Windows has no signals: there, either one ends the process.
 *
 * Used by the Claude runtime (claude-runtime.provider.js) to stop a turn
 * another process runs, at the Codey user's request.
 * @returns Whether the signal was delivered
 */
export async function signalForeignSessionProcess(owner: ForeignSessionProcess, signal: 'SIGINT' | 'SIGTERM'): Promise<boolean> {
  if (!(await isLive(owner.pid, owner.procStart))) {
    return false;
  }
  try {
    process.kill(owner.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * The session a registration file belongs to, when a process outside Codey
 * wrote it; null for Codey's own processes and unreadable files.
 *
 * Used by the sessions watcher (sessions-watcher.service.ts): a registration
 * changes as that process starts, begins a turn and ends one, which tells
 * Codey to refresh the session seconds before its transcript poll would.
 */
export async function readForeignRegistrationSessionId(filePath: string): Promise<string | null> {
  if (!/^\d+\.json$/.test(path.basename(filePath))) {
    return null;
  }
  const record = await readRegistration(filePath);
  return record && readForeignRegistration(record) ? readString(record.sessionId) : null;
}

/**
 * Where Claude Code keeps the transcript of a session started in `cwd`, or
 * null when that folder name is one Claude Code shortens and hashes.
 */
function projectTranscriptPath(providerSessionId: string, cwd: string | undefined | null): string | null {
  if (!cwd) {
    return null;
  }
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (folder.length > MAX_PROJECT_FOLDER_LENGTH) {
    return null;
  }
  return path.join(claudeHome(), 'projects', folder, `${providerSessionId}.jsonl`);
}

/**
 * The last rows of a session's transcript, newest last, or null when it
 * cannot be found or read. A first line cut by the tail window is dropped.
 */
async function readTranscriptTail(providerSessionId: string, cwd: string | undefined | null): Promise<Record<string, unknown>[] | null> {
  const transcriptPath = projectTranscriptPath(providerSessionId, cwd);
  if (!transcriptPath) {
    return null;
  }

  let tail: string;
  let partialFirstLine: boolean;
  try {
    const file = await open(transcriptPath, 'r');
    try {
      const { size } = await file.stat();
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      tail = buffer.toString('utf8');
      partialFirstLine = length < size;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }

  const rows: Record<string, unknown>[] = [];
  const lines = tail.split('\n');
  for (let index = partialFirstLine ? 1 : 0; index < lines.length; index += 1) {
    try {
      const row = JSON.parse(lines[index]);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      // A line still being written, or not JSON.
    }
  }
  return rows;
}

/**
 * Whether the session's latest turn was written by a process outside Codey,
 * judged from the `entrypoint` of the transcript's last row that has one.
 * A resident Codey process that sat idle meanwhile holds a stale copy of the
 * conversation, and continuing in it would fork the transcript.
 *
 * Used by the Claude runtime (claude-runtime.provider.js) before it hands a
 * turn to a resident process.
 * @param providerSessionId - Claude Code's session id
 * @param cwd - Working directory the session runs in; locates its transcript
 * @returns False when the transcript cannot be found or read, which keeps the
 *   resident process
 */
export async function isTranscriptContinuedElsewhere(providerSessionId: string, cwd: string | undefined): Promise<boolean> {
  const rows = await readTranscriptTail(providerSessionId, cwd);
  for (let index = (rows?.length ?? 0) - 1; index >= 0; index -= 1) {
    // Metadata rows (titles, last prompt, mode) carry no entrypoint.
    const entrypoint = rows![index].entrypoint;
    if (typeof entrypoint === 'string') {
      return entrypoint !== CODEY_CLAUDE_ENTRYPOINT;
    }
  }
  return false;
}

/**
 * The permission mode the session's latest prompt ran in, as Claude Code
 * records it on each prompt row; null when the transcript does not say.
 *
 * Used by session messages (session-message-delivery.service.ts): a process
 * holds a message from another session for its user's approval when the
 * mode the sender declares does not match its own.
 */
export async function readLastPermissionMode(providerSessionId: string, cwd: string | null): Promise<string | null> {
  const rows = await readTranscriptTail(providerSessionId, cwd);
  for (let index = (rows?.length ?? 0) - 1; index >= 0; index -= 1) {
    const mode = rows![index].permissionMode;
    if (typeof mode === 'string' && mode) {
      return mode;
    }
  }
  return null;
}

/**
 * The session's transcript: in the project folder of `cwd` when it is there,
 * else in whichever project folder has it (a session started in a directory
 * other than the project's, or one whose folder name Claude Code hashed).
 */
async function locateTranscript(providerSessionId: string, cwd: string | null | undefined): Promise<string | null> {
  const expected = projectTranscriptPath(providerSessionId, cwd);
  if (expected && await stat(expected).then(() => true, () => false)) {
    return expected;
  }
  const projects = path.join(claudeHome(), 'projects');
  let folders: string[];
  try {
    folders = await readdir(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = path.join(projects, folder, `${providerSessionId}.jsonl`);
    if (await stat(candidate).then(() => true, () => false)) {
      return candidate;
    }
  }
  return null;
}

const isConversationRow = (row: Record<string, unknown>): boolean => (row.type === 'user' || row.type === 'assistant')
  && row.isMeta !== true && row.isSidechain !== true;

/** A row with the user's own input, as opposed to a tool result fed back to the model. */
function isPromptRow(row: Record<string, unknown>): boolean {
  if (row.type !== 'user' || !isConversationRow(row)) {
    return false;
  }
  const content = (row.message as { content?: unknown } | undefined)?.content;
  return !Array.isArray(content) || !content.some((part) => (part as { type?: unknown })?.type === 'tool_result');
}

/**
 * Byte offset of the latest prompt row within the transcript's tail, which is
 * where the turn running now starts; the first whole line of the tail when the
 * prompt is further back than that.
 */
async function findTurnStart(transcriptPath: string): Promise<number> {
  let tail: Buffer;
  let tailStart: number;
  try {
    const file = await open(transcriptPath, 'r');
    try {
      const { size } = await file.stat();
      tailStart = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      tail = Buffer.alloc(size - tailStart);
      await file.read(tail, 0, tail.length, tailStart);
    } finally {
      await file.close();
    }
  } catch {
    return 0;
  }

  // A tail that is not the whole file starts in the middle of a line.
  const firstNewline = tail.indexOf(0x0a);
  if (tailStart > 0 && firstNewline < 0) {
    return tailStart + tail.length;
  }
  const firstWholeLine = tailStart === 0 ? 0 : firstNewline + 1;
  let turnStart: number | null = null;
  let lineStart = firstWholeLine;
  while (lineStart < tail.length) {
    const lineEnd = tail.indexOf(0x0a, lineStart);
    if (lineEnd < 0) {
      break;
    }
    const row = parseRow(tail.subarray(lineStart, lineEnd).toString('utf8'));
    if (row && isPromptRow(row)) {
      turnStart = lineStart;
    }
    lineStart = lineEnd + 1;
  }
  return tailStart + (turnStart ?? firstWholeLine);
}

function parseRow(line: string): Record<string, unknown> | null {
  try {
    const row = JSON.parse(line);
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

/**
 * Forwards the conversation rows another Claude Code process writes while it
 * runs a turn of the session, starting with the prompt that began the turn,
 * until that process is between turns again or has let the session go.
 * Claude Code appends a row as each message completes, so this shows whole
 * messages and tool calls, not text as it streams. Rows a client already has
 * carry the same ids and replace their copies.
 *
 * Used by the Claude runtime (claude-runtime.provider.js): an open Codey tab
 * shows a turn Claude Desktop or a terminal runs, and a Codey turn sent
 * meanwhile shows it while it waits for it to end.
 * @returns How following ended: the process went idle, let the session go, or
 *   the caller stopped following
 */
export async function followForeignTurn({
  owner, providerSessionId, cwd, onRow, signal,
}: {
  owner: ForeignSessionProcess;
  providerSessionId: string;
  cwd: string | null | undefined;
  onRow: (row: Record<string, unknown>) => void;
  signal: AbortSignal;
}): Promise<'idle' | 'gone' | 'aborted'> {
  let transcriptPath: string | null = null;
  let offset = 0;
  // The start of a row still being written, kept as bytes so a character
  // split across reads is decoded whole.
  let partial = Buffer.alloc(0);

  const drain = async () => {
    if (!transcriptPath) {
      transcriptPath = await locateTranscript(providerSessionId, cwd ?? owner.cwd);
      if (!transcriptPath) {
        return;
      }
      offset = await findTurnStart(transcriptPath);
    }
    let file;
    try {
      file = await open(transcriptPath, 'r');
    } catch {
      return;
    }
    try {
      const { size } = await file.stat();
      if (size < offset) {
        // Rewritten from scratch; what was forwarded stands, history settles the rest.
        offset = size;
        partial = Buffer.alloc(0);
        return;
      }
      if (size === offset) {
        return;
      }
      const chunk = Buffer.alloc(size - offset);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      offset += bytesRead;
      let data = Buffer.concat([partial, chunk.subarray(0, bytesRead)]);
      let lineEnd = data.indexOf(0x0a);
      while (lineEnd >= 0) {
        const row = parseRow(data.subarray(0, lineEnd).toString('utf8'));
        if (row && isConversationRow(row)) {
          onRow(row);
        }
        data = data.subarray(lineEnd + 1);
        lineEnd = data.indexOf(0x0a);
      }
      partial = Buffer.from(data);
    } finally {
      await file.close();
    }
  };

  while (!signal.aborted) {
    await drain();
    const status = await readForeignSessionStatus(owner, providerSessionId);
    if (status === 'idle' || status === 'gone') {
      await drain();
      return status;
    }
    await pause(FOLLOW_POLL_MS, signal);
  }
  return 'aborted';
}
