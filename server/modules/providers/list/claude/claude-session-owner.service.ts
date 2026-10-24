import { open, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The entrypoint every Claude Code process Codey launches registers with: the
 * Agent SDK's. The Claude runtime (claude-runtime.provider.js) pins it in the
 * launch environment, so a Codey node started from a Claude Desktop or
 * terminal shell cannot inherit theirs and mistake its own processes for them.
 */
export const CODEY_CLAUDE_ENTRYPOINT = 'sdk-ts';

// The longest transcript tail read to find the last process that wrote a turn.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
// Claude Code shortens (and hashes) longer project folder names.
const MAX_PROJECT_FOLDER_LENGTH = 200;

type ForeignSessionProcess = {
  pid: number;
  entrypoint: string;
  /** Where the process takes messages from other sessions; absent before Claude Code 2.1.2xx. */
  messagingSocketPath: string | null;
  cwd: string | null;
};

const claudeHome = (): string => path.join(os.homedir(), '.claude');

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

/**
 * Finds a live Claude Code process outside Codey that has the session open —
 * Claude Desktop, or `claude --resume` in a terminal. Every interactive Claude
 * Code process registers itself in `~/.claude/sessions/<pid>.json` until it
 * exits. A turn Codey started for the same session would be a second process
 * continuing it: neither sees the other's turns, and the transcript forks.
 *
 * Used by the Claude runtime (claude-runtime.provider.js) before it resumes a
 * session.
 * @param providerSessionId - Claude Code's session id
 * @returns The first such process, or null when no other process has it open
 */
export async function findForeignSessionProcess(providerSessionId: string): Promise<ForeignSessionProcess | null> {
  const directory = path.join(claudeHome(), 'sessions');
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
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    } catch {
      // Being written or removed right now.
      continue;
    }
    if (record?.sessionId !== providerSessionId) {
      continue;
    }
    const entrypoint = typeof record.entrypoint === 'string' ? record.entrypoint : 'unknown';
    const pid = Number(record.pid);
    if (entrypoint === CODEY_CLAUDE_ENTRYPOINT || !Number.isSafeInteger(pid) || pid <= 0) {
      continue;
    }
    if (isRunning(pid) && !(await isReusedPid(pid, record.procStart))) {
      return {
        pid,
        entrypoint,
        messagingSocketPath: typeof record.messagingSocketPath === 'string' && record.messagingSocketPath
          ? record.messagingSocketPath : null,
        cwd: typeof record.cwd === 'string' && record.cwd ? record.cwd : null,
      };
    }
  }
  return null;
}

/**
 * The last rows of a session's transcript, newest last, or null when it
 * cannot be found or read. A first line cut by the tail window is dropped.
 */
async function readTranscriptTail(providerSessionId: string, cwd: string | undefined | null): Promise<Record<string, unknown>[] | null> {
  if (!cwd) {
    return null;
  }
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (folder.length > MAX_PROJECT_FOLDER_LENGTH) {
    return null;
  }

  let tail: string;
  let partialFirstLine: boolean;
  try {
    const file = await open(path.join(claudeHome(), 'projects', folder, `${providerSessionId}.jsonl`), 'r');
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
