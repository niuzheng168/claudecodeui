import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

/**
 * Hands a message to a Claude Code process that is not Codey's own — Claude
 * Desktop, or `claude` in a terminal — through the socket every such process
 * listens on for messages from other sessions (`messagingSocketPath` in
 * `~/.claude/sessions/<pid>.json`). The process shows it as a message from
 * another session: it starts a turn when idle, and folds it in at the next
 * tool round when busy. Read from Claude Code 2.1.267 and 2.1.304.
 */

const TAG = 'cross-session-message';
// The receiver accepts a sender address made of these characters only.
const ADDRESS = /^[A-Za-z0-9%:_/.\\-]{1,300}$/;
const MAX_LINE_CHARS = 1_048_576;
const SEND_TIMEOUT_MS = 5_000;

/**
 * The receiver re-renders the wrapper and compares it with what arrived, so
 * a sender name must already be in the form it would render: no quotes or
 * angle brackets, no control or format characters, at most 64 code points.
 */
function canonicalName(name: string): string {
  const cleaned = name.replace(/["<>]/g, '').replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim();
  const points = [...cleaned];
  return points.length > 64 ? `${points.slice(0, 64).join('')}…` : cleaned;
}

/**
 * The wrapper Claude Code's own SendMessage writes. `from-mode` says whether
 * the sending side bypasses permissions; a receiver whose own mode differs
 * holds the message for its user's approval instead of acting on it, so the
 * caller passes the receiver's own mode when it is known.
 */
export function crossSessionMessage(input: {
  from: string;
  name: string;
  mode: 'bypass' | 'prompting' | null;
  body: string;
}): string {
  const attributes = [`from="${input.from}"`];
  const name = canonicalName(input.name);
  if (name) attributes.push(`from-name="${name}"`);
  if (input.mode) attributes.push(`from-mode="${input.mode}"`);
  // A closing tag inside the body would end the wrapper early.
  const body = input.body.replace(new RegExp(`</${TAG}`, 'gi'), `<\\/${TAG}`);
  return `<${TAG} ${attributes.join(' ')}>\n${body}\n</${TAG}>`;
}

/** The mode a receiver compares with `from-mode`, from the permission mode its transcript records. */
export function senderModeFor(permissionMode: string | null): 'bypass' | 'prompting' | null {
  if (!permissionMode) return null;
  return permissionMode === 'bypassPermissions' ? 'bypass' : 'prompting';
}

/**
 * The token that marks a connection as a peer. Required on Windows, where the
 * socket is a named pipe; elsewhere a connection without it is accepted too.
 */
async function peerToken(pid: number, socketPath: string): Promise<string | null> {
  const digest = createHash('sha256').update(socketPath).digest('hex');
  try {
    const file = path.join(os.homedir(), '.claude', 'sessions', `${pid}.${digest}.key`);
    const token = JSON.parse(await readFile(file, 'utf8'))?.peerToken;
    return typeof token === 'string' && /^[a-f0-9]{16,128}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export async function sendToClaudeProcess(input: {
  pid: number;
  socketPath: string;
  providerSessionId: string;
  from: string;
  content: string;
}): Promise<void> {
  if (!ADDRESS.test(input.from)) {
    throw new AppError('The sender address cannot be passed to Claude Code.', { code: 'SESSION_MESSAGE_INVALID', statusCode: 400 });
  }
  const token = await peerToken(input.pid, input.socketPath);
  if (!token && process.platform === 'win32') {
    throw new AppError('This Claude session does not accept messages from Codey on Windows yet.', {
      code: 'SESSION_MESSAGE_UNDELIVERABLE', statusCode: 409,
    });
  }
  const line = JSON.stringify({
    msgV: 1,
    msg_id: randomUUID(),
    type: 'user',
    message: { role: 'user', content: input.content },
    priority: 'next',
    from: input.from,
    // The receiver drops a message addressed to a session it no longer holds.
    session_id: input.providerSessionId,
  });
  if (line.length > MAX_LINE_CHARS) {
    throw new AppError('The message is too long for Claude Code.', { code: 'SESSION_MESSAGE_TOO_LARGE', statusCode: 413 });
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(input.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AppError('The Claude session did not take the message in time.', {
        code: 'SESSION_MESSAGE_UNDELIVERABLE', statusCode: 504,
      }));
    }, SEND_TIMEOUT_MS);
    socket.once('error', () => {
      clearTimeout(timer);
      reject(new AppError('The Claude session is not accepting messages; it may have just closed.', {
        code: 'SESSION_MESSAGE_UNDELIVERABLE', statusCode: 409,
      }));
    });
    socket.once('connect', () => {
      if (token) socket.write(`${JSON.stringify({ type: 'auth', token })}\n`);
      socket.write(`${line}\n`, () => {
        // Claude Code's own sender pauses before closing on macOS so the line is read first.
        setTimeout(() => socket.end(), process.platform === 'darwin' ? 150 : 0);
      });
    });
    socket.once('close', (hadError) => {
      clearTimeout(timer);
      if (!hadError) resolve();
    });
  });
}
