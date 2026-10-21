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
      return { pid, entrypoint };
    }
  }
  return null;
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
  if (!cwd) {
    return false;
  }
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (folder.length > MAX_PROJECT_FOLDER_LENGTH) {
    return false;
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
    return false;
  }

  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= (partialFirstLine ? 1 : 0); index -= 1) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    // Metadata rows (titles, last prompt, mode) carry no entrypoint.
    if (typeof row?.entrypoint === 'string') {
      return row.entrypoint !== CODEY_CLAUDE_ENTRYPOINT;
    }
  }
  return false;
}
