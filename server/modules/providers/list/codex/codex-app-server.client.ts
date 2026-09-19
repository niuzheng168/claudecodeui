import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

import type { AnyRecord, ICodexRpcClient } from '@/shared/index.js';
import { AppError, readObjectRecord, resolveCodexHomeDirectory } from '@/shared/index.js';
import { readCodexHistoryMode } from '@/modules/providers/list/codex/codex-thread-storage.repository.js';

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * Codex ships two entry points and they expose different things. The
 * `@openai/codex-sdk` this app runs conversations through is a wrapper around
 * `codex exec`, and its whole surface is `startThread` and `resumeThread` —
 * there is no way to branch a thread or to resume one partway. The same
 * binary's `app-server` subcommand speaks JSON-RPC and does have that
 * primitive, `thread/fork`, which is what the Codex IDE clients build their
 * own "fork" and "edit an earlier message" on top of.
 *
 * Legacy forks use the packaged CLI. Native history on every platform may instead use
 * the explicitly configured desktop CLI for a strictly read-only snapshot.
 * Neither path substitutes for the desktop owner when running native turns;
 * native paginated forks must still stay in Codex app.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;
const READ_ONLY_METHODS = new Set(['initialize', 'thread/read', 'thread/turns/list', 'thread/loaded/list']);

type AppServerMode =
  | { kind: 'legacy-fork' }
  | { kind: 'read-only'; executable: string; home: string; timeoutMs: number };

type JsonRpcResponse = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
export type CodexThreadFork = {
  threadId: string;
  path: string;
};

/**
 * Resolve the explicitly configured owner CLI first. Managed Codey packages
 * install Codex from OpenAI and do not carry a second native runtime.
 */
function resolveCodexLauncher(): { executable: string; args: string[] } {
  const configured = process.env.CODEY_CODEX_EXECUTABLE;
  if (configured && path.isAbsolute(configured)) {
    return { executable: configured, args: ['app-server', '--stdio'] };
  }
  const require_ = createRequire(import.meta.url);
  try {
    return {
      executable: process.execPath,
      args: [require_.resolve('@openai/codex/bin/codex.js'), 'app-server'],
    };
  } catch {
    throw new AppError('No configured Codex CLI is available, so Codex conversations cannot be branched.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
}

/**
 * Runs one exchange against a freshly spawned `codex app-server`.
 *
 * A process per operation keeps read-only snapshots isolated from live thread
 * writers and preserves the existing legacy-fork lifecycle. No pooled runtime
 * is created or attached to an existing desktop turn.
 */
async function withAppServer<T>(
  run: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
  mode: AppServerMode = { kind: 'legacy-fork' },
): Promise<T> {
  const readOnly = mode.kind === 'read-only';
  const command = readOnly
    ? { executable: mode.executable, args: ['app-server', '--stdio'] }
    : resolveCodexLauncher();
  const { executable, args } = command;
  const requestTimeoutMs = readOnly ? mode.timeoutMs : REQUEST_TIMEOUT_MS;
  const child = spawn(executable, args, {
    ...(readOnly ? { cwd: mode.home } : {}),
    env: readOnly ? { ...process.env, CODEX_HOME: mode.home } : process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    if (!readOnly) stderr = (stderr + String(chunk)).slice(-2000);
  });

  let nextRequestId = 1;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let exitReason: string | null = null;

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Server-to-client notifications and any non-JSON banner are not
      // replies to anything this client asked for.
      return;
    }
    if (typeof message.method === 'string' || typeof message.id !== 'number') {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const failPending = (reason: string) => {
    exitReason = reason;
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
  };

  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    failPending(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });
  // A child that dies mid-request leaves its pipes broken, and the next write
  // raises EPIPE on the stream rather than at the call site. Without a
  // listener that is an unhandled 'error' event, which takes the whole server
  // down over one failed fork.
  child.stdin?.on('error', (error) => failPending(error.message));
  child.stdout?.on('error', (error) => failPending(error.message));
  child.stderr?.on('error', () => {});

  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (readOnly && !READ_ONLY_METHODS.has(method)) {
        reject(new AppError('A mutating RPC is not allowed in the Codex history reader.', {
          code: 'CODEX_HISTORY_READER_UNSAFE',
          statusCode: 502,
        }));
        return;
      }
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${requestTimeoutMs}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, requestTimeoutMs);

      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new AppError(response.error.message || `Codex app-server rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
            details: { method, rpcCode: response.error.code },
          }));
          return;
        }
        resolve(response.result);
      });

      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    // Legacy forks use the stable protocol. The format-aware desktop history
    // reader advertises native item support but can only send read-only RPCs.
    await call('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: readOnly ? { experimentalApi: true } : {},
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    return await run(call);
  } catch (error) {
    if (error instanceof AppError && exitReason) {
      throw new AppError(`${error.message}${stderr ? ` — ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`, {
        code: error.code,
        statusCode: error.statusCode,
      });
    }
    throw error;
  } finally {
    reader.close();
    // A killed Windows child can briefly retain its cwd/handles. Wait for our
    // own child's pipes to close before returning; never stop another process.
    await new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin?.end();
      child.kill();
    });
  }
}

async function readNativeSnapshot(
  call: (method: string, params: AnyRecord) => Promise<unknown>,
  threadId: string,
  readerOnly: boolean,
): Promise<AnyRecord> {
  const snapshot = readObjectRecord(await call('thread/read', { threadId, includeTurns: false }));
  const thread = readObjectRecord(snapshot?.thread);
  if (!thread || thread.id !== threadId) throw new Error('invalid snapshot identity');

  let turns: AnyRecord[] = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  const turnIds = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= 200) throw new Error('native history exceeds the bounded page window');
    let result: AnyRecord | null;
    try {
      result = readObjectRecord(await call('thread/turns/list', {
        threadId, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full',
      }));
    } catch (error) {
      // Older backends may only implement inclusive thread/read. This is a
      // read-only capability fallback, never a retry of a submitted prompt.
      const details = readObjectRecord(readObjectRecord(error)?.details);
      if (page !== 0 || details?.rpcCode !== -32601) throw error;
      const legacy = readObjectRecord(await call('thread/read', { threadId, includeTurns: true }));
      if (legacy?.thread?.id !== threadId || !Array.isArray(legacy.thread.turns)) {
        throw new Error('invalid legacy snapshot');
      }
      turns = legacy.thread.turns;
      break;
    }
    if (!result || !Array.isArray(result.data)) throw new Error('invalid native turn page');
    for (const turn of result.data) {
      if (typeof turn?.id !== 'string' || !turn.id || !Array.isArray(turn.items) || turnIds.has(turn.id)
        || (turn.itemsView != null && turn.itemsView !== 'full')) {
        throw new Error('invalid or repeated native turn');
      }
      turnIds.add(turn.id);
      turns.push(turn);
    }
    if (result.nextCursor == null) break;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) {
      throw new Error('invalid native history cursor');
    }
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  if (readerOnly) {
    const loaded = readObjectRecord(await call('thread/loaded/list', {}));
    if (!loaded || !Array.isArray(loaded.data) || loaded.data.length !== 0) {
      throw new Error('reader acquired a thread');
    }
  }
  return { ...thread, turns };
}

// Used by CodexSessionsProvider for native history and legacy fork/edit operations.
export const codexAppServer = {
  /**
   * Used by CodexSessionsProvider with the selected native connection on every
   * platform. Without a connection, reads through the explicitly configured
   * CLI, never one found in the project/PATH or a guessed JSONL export.
   * No resume/start/fork RPC is permitted and the temporary process must retain
   * an empty loaded-thread list before its snapshot is returned.
   */
  async readThreadSnapshot(
    threadId: string,
    { timeoutMs = 10_000, client }: { timeoutMs?: number; client?: ICodexRpcClient } = {},
  ): Promise<AnyRecord> {
    if (client) {
      try {
        return await readNativeSnapshot((method, params) => client.request(method, params), threadId, Boolean(client.ownsProcess));
      } catch {
        throw new AppError('Could not read complete native Codex history with the selected backend.', {
          code: 'CODEX_HISTORY_UNAVAILABLE', statusCode: 502,
        });
      }
    }
    const executable = process.env.CODEY_CODEX_EXECUTABLE;
    if (!executable || !path.isAbsolute(executable)) {
      throw new AppError('The native Codex history reader has no configured desktop executable.', {
        code: 'CODEX_HISTORY_READER_UNAVAILABLE',
        statusCode: 503,
      });
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) {
      throw new AppError('Invalid Codex history reader deadline.', {
        code: 'CODEX_HISTORY_READER_UNAVAILABLE',
        statusCode: 503,
      });
    }
    try {
      if (!(await stat(executable)).isFile()) throw new Error('missing executable');
      return await withAppServer(call => readNativeSnapshot(call, threadId, true), {
        kind: 'read-only', executable, home: resolveCodexHomeDirectory(), timeoutMs,
      });
    } catch {
      // RPC/stderr text can contain private transcript or provider details.
      // Unsupported native formats fail explicitly, never as an empty export.
      throw new AppError('Could not read native Codex history with the configured read-only desktop reader.', {
        code: 'CODEX_HISTORY_UNAVAILABLE',
        statusCode: 502,
      });
    }
  },

  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    const historyMode = await readCodexHistoryMode(input.threadId);
    if (historyMode && historyMode !== 'legacy') {
      throw new AppError('Fork or edit this native paginated session in Codex app. The legacy Codey fork adapter cannot safely copy its history.', {
        code: 'CODEX_NATIVE_FORK_UNSUPPORTED',
        statusCode: 409,
      });
    }
    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      return { threadId, path };
    });
  },
};
