import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

import type { AnyRecord, CodexHistoryPageRequest, ICodexRpcClient, NativeTranscriptPosition } from '@/shared/index.js';
import { AppError, SIDE_CONVERSATION_BOUNDARY_PROMPT, SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS, SIDE_QUESTION_ANSWER_SEPARATOR, readObjectRecord, resolveCodexHomeDirectory } from '@/shared/index.js';
import { readCodexHistoryMode } from '@/modules/providers/list/codex/codex-thread-storage.repository.js';
import { connectCodexNativeClient } from '@/modules/providers/list/codex/codex-native-client.service.js';

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
 * Explicit native forks use the selected native runtime and exclude history
 * hydration. Legacy edit/rewind callers do not opt in to that mutation.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;
const READ_ONLY_METHODS = new Set([
  'initialize', 'thread/read', 'thread/turns/list', 'thread/items/list', 'thread/loaded/list',
]);
const MAX_HISTORY_TURNS = 20_000;
const MAX_HISTORY_ITEMS = 100_000;
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_DURATION_MS = 60_000;

type HistoryCall = (method: string, params: AnyRecord) => Promise<unknown>;

function unsupportedMethod(error: unknown): boolean {
  return readObjectRecord(readObjectRecord(error)?.details)?.rpcCode === -32601;
}

function nextHistoryCursor(result: AnyRecord, seen: Set<string>): string | null {
  if (result.nextCursor == null) return null;
  if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) {
    throw new Error('invalid native history cursor');
  }
  seen.add(result.nextCursor);
  return result.nextCursor;
}

type AppServerMode =
  | { kind: 'legacy-fork' }
  | { kind: 'read-only'; executable: string; home: string; timeoutMs: number };

/**
 * How long a side-question turn may run before it is given up on. Not
 * measured like `REQUEST_TIMEOUT_MS`: a side question is a model turn, not a
 * handshake request, and can legitimately run for minutes on a hard
 * question. 5 minutes is a generous ceiling against a turn that never sends
 * `turn/completed` (a hung child, a provider bug) rather than a tuned value.
 */
const SIDE_QUESTION_TURN_TIMEOUT_MS = 5 * 60_000;

type JsonRpcResponse = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** A line from the app-server: a reply to us, a notification, or a server request. */
type JsonRpcLine = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** Handler for a notification the app-server sent us (never a reply). */
type NotificationHandler = (method: string, params: unknown) => void;

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
  try {
    return {
      executable: process.execPath,
      args: [codexAppServer.resolveLauncher(), 'app-server'],
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
  run: (helpers: {
    call: (method: string, params: unknown) => Promise<unknown>;
    /** Registers a handler for every notification (no `id`) the app-server sends. Returns a function that removes it. */
    onNotification: (handler: NotificationHandler) => () => void;
    /**
     * Registers a handler for the child exiting or erroring. Separate from
     * `call()`'s own rejection: a waiter that is not sitting on a pending
     * request (e.g. `askSideQuestion` waiting on a `turn/completed`
     * notification) would otherwise only learn the child is gone once its
     * own timeout fires, minutes later.
     */
    onExit: (handler: (reason: string) => void) => () => void;
  }) => Promise<T>,
  mode: AppServerMode = { kind: 'legacy-fork' },
  signal?: AbortSignal,
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
  const notificationListeners = new Set<NotificationHandler>();
  let exitReason: string | null = null;

  const onNotification = (handler: NotificationHandler): (() => void) => {
    notificationListeners.add(handler);
    return () => notificationListeners.delete(handler);
  };

  const exitListeners = new Set<(reason: string) => void>();
  const onExit = (handler: (reason: string) => void): (() => void) => {
    exitListeners.add(handler);
    return () => exitListeners.delete(handler);
  };

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcLine;
    try {
      message = JSON.parse(line) as JsonRpcLine;
    } catch {
      // Any non-JSON banner is not a reply to anything this client asked for.
      return;
    }

    // A line with `method` is never a reply, even when its `id` happens to
    // match one of our own pending requests (the app-server reuses our
    // `turn/start` id when it turns around and asks *us* something).
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number') {
        // A server request (`item/tool/requestUserInput`,
        // `mcpServer/elicitation/request`, `item/tool/call`, …) that
        // `approvalPolicy: 'never'` does not suppress. A side question has no
        // one to answer it, so it is rejected at once rather than left
        // pending — an unanswered one stalls the turn that is waiting on it.
        child.stdin?.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Side questions do not support interactive requests.' },
        })}\n`);
        return;
      }
      for (const handler of notificationListeners) {
        handler(message.method, message.params);
      }
      return;
    }

    if (typeof message.id !== 'number') {
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
    for (const listener of exitListeners) {
      listener(reason);
    }
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

  // Attached before `initialize`: `run` adds its own abort listener only
  // once the handshake has returned, so a dismiss while `initialize` hangs
  // would otherwise leave the child up until REQUEST_TIMEOUT_MS. Killing it
  // fails that pending call through the exit handler above.
  const killOnAbort = () => child.kill();
  signal?.addEventListener('abort', killOnAbort, { once: true });

  try {
    // Legacy forks use the stable protocol. The format-aware desktop history
    // reader advertises native item support but can only send read-only RPCs.
    await call('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: readOnly ? { experimentalApi: true } : {},
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    return await run({ call, onNotification, onExit });
  } catch (error) {
    if (error instanceof AppError && exitReason) {
      throw new AppError(`${error.message}${stderr ? ` — ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`, {
        code: error.code,
        statusCode: error.statusCode,
      });
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', killOnAbort);
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
  call: HistoryCall,
  threadId: string,
  readerOnly: boolean,
  afterPosition?: NativeTranscriptPosition,
  maxItems = MAX_HISTORY_ITEMS,
  isVisibleItem: (item: AnyRecord) => boolean = () => true,
): Promise<AnyRecord> {
  const snapshot = readObjectRecord(await call('thread/read', { threadId, includeTurns: false }));
  const thread = readObjectRecord(snapshot?.thread);
  if (!thread || thread.id !== threadId) throw new Error('invalid snapshot identity');

  const deadline = Date.now() + MAX_HISTORY_DURATION_MS;
  let historyBytes = 0;
  let itemCount = 0;
  let visibleItemCount = 0;
  const checkBudget = (value?: AnyRecord) => {
    if (value) historyBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (historyBytes > MAX_HISTORY_BYTES || itemCount > MAX_HISTORY_ITEMS || Date.now() > deadline) {
      throw new Error('native history exceeds the bounded snapshot window');
    }
  };
  const readTurns = async (itemsView: 'notLoaded' | 'full'): Promise<AnyRecord[]> => {
    const turns: AnyRecord[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      checkBudget();
      if (page >= MAX_HISTORY_TURNS) throw new Error('too many native turn pages');
      let result: AnyRecord | null;
      try {
        result = readObjectRecord(await call('thread/turns/list', {
          // A compatibility backend may only support full turns. Bound those
          // pages to one turn rather than joining many large turns in one frame.
          threadId, cursor, limit: itemsView === 'full' ? 1 : 100, sortDirection: 'asc', itemsView,
        }));
      } catch (error) {
        if (page !== 0 || !unsupportedMethod(error)) throw error;
        // Only a positively unsupported method permits an older read-only
        // protocol. Never resume, change backend, or use a partial JSONL export.
        const legacy = readObjectRecord(await call('thread/read', { threadId, includeTurns: true }));
        if (legacy?.thread?.id !== threadId || !Array.isArray(legacy.thread.turns)) {
          throw new Error('invalid legacy snapshot');
        }
        result = { data: legacy.thread.turns, nextCursor: null };
      }
      if (!result || !Array.isArray(result.data)) throw new Error('invalid native turn page');
      for (const raw of result.data) {
        const turn = readObjectRecord(raw);
        if (!turn || typeof turn.id !== 'string' || !turn.id || ids.has(turn.id)
          || !Array.isArray(turn.items) || (turn.itemsView != null
            && turn.itemsView !== 'full' && turn.itemsView !== itemsView)) {
          throw new Error('invalid or repeated native turn');
        }
        if (turn.itemsView === 'notLoaded' && turn.items.length !== 0) throw new Error('unexpected unloaded items');
        ids.add(turn.id);
        if (ids.size > MAX_HISTORY_TURNS) throw new Error('too many native turns');
        checkBudget(turn);
        turns.push({ ...turn, items: [...turn.items] });
      }
      cursor = nextHistoryCursor(result, cursors);
      if (cursor === null) return turns;
      if (result.data.length === 0) throw new Error('native turn page made no progress');
    }
  };

  let turns = await readTurns('notLoaded');
  if (afterPosition) {
    const start = turns.findIndex(turn => turn.id === afterPosition.turnId);
    if (start < 0 || afterPosition.cursor === undefined) {
      throw new AppError('The native history anchor no longer exists.', {
        code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
      });
    }
    turns = turns.slice(start);
  }
  let itemPaginationConfirmed = false;
  let hasNewer = false;
  for (const [turnIndex, turn] of turns.entries()) {
    // Old backends may ignore itemsView and return full turns. Their complete
    // items remain usable; a summary is never accepted as complete history.
    if (turn.itemsView !== 'notLoaded') {
      if (afterPosition) {
        throw new AppError('The native backend no longer supports the history cursor.', {
          code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
        });
      }
      itemCount += turn.items.length;
      checkBudget();
      continue;
    }
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = turnIndex === 0 ? afterPosition?.cursor ?? null : null;
    turn.itemOffset = turnIndex === 0 ? afterPosition?.itemIndex ?? 0 : 0;
    turn.itemCursors = [];
    do {
      checkBudget();
      let result: AnyRecord | null;
      try {
        result = readObjectRecord(await call('thread/items/list', {
          // A single turn (or a page of screenshot-bearing items) can exceed
          // the stdio frame limit. One item per RPC keeps the transport bound
          // independent of both turn length and the size of adjacent items.
          threadId, turnId: turn.id, cursor, limit: 1, sortDirection: 'asc',
        }));
      } catch (error) {
        if (afterPosition || itemPaginationConfirmed || !unsupportedMethod(error)) throw error;
        turns = await readTurns('full');
        itemCount = turns.reduce((count, value) => count + value.items.length, 0);
        checkBudget();
        break;
      }
      if (!result || !Array.isArray(result.data) || result.data.length > 1
        || !Object.hasOwn(result, 'nextCursor')) {
        throw new Error('invalid native item page');
      }
      itemPaginationConfirmed = true;
      for (const entry of result.data) {
        const item = readObjectRecord(entry?.item);
        if (entry?.turnId !== turn.id || !item || typeof item.id !== 'string' || !item.id
          || typeof item.type !== 'string' || !item.type || ids.has(item.id)) {
          throw new Error('invalid, foreign or repeated native item');
        }
        ids.add(item.id);
        if (afterPosition && itemCount === 0 && item.id !== afterPosition.itemId) {
          throw new AppError('The native history anchor changed.', {
            code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
          });
        }
        itemCount++;
        if (isVisibleItem(item)) visibleItemCount++;
        checkBudget(item);
        turn.itemCursors.push(cursor);
        turn.items.push(item);
      }
      cursor = nextHistoryCursor(result, cursors);
      if (cursor !== null && result.data.length === 0) throw new Error('native item page made no progress');
      if (afterPosition && visibleItemCount >= maxItems && (cursor !== null || turnIndex < turns.length - 1)) {
        hasNewer = true;
        break;
      }
    } while (cursor !== null);
    if (!itemPaginationConfirmed) break; // Explicit legacy capability fallback.
    turn.itemsView = 'full';
    if (hasNewer) {
      turns = turns.slice(0, turnIndex + 1);
      break;
    }
  }
  if (readerOnly) {
    const loaded = readObjectRecord(await call('thread/loaded/list', {}));
    if (!loaded || !Array.isArray(loaded.data) || loaded.data.length !== 0) {
      throw new Error('reader acquired a thread');
    }
  }
  return { ...thread, turns, ...(afterPosition ? { hasNewer } : {}) };
}

// Used by CodexSessionsProvider for native history and legacy fork/edit operations.
export const codexAppServer = {
  /**
   * Used by CodexSessionsProvider for cold/older/forward pages. Read newest
   * native items directly, including inherited fork history, never all turns'
   * items before returning the first screen. Each item is an atomic frame.
   */
  async readThreadPage(
    threadId: string,
    client: ICodexRpcClient,
    page: CodexHistoryPageRequest,
    isVisibleItem: (item: AnyRecord) => boolean,
  ): Promise<AnyRecord> {
    try {
      const metadata = readObjectRecord(await client.request('thread/read', { threadId, includeTurns: false }));
      if (metadata?.thread?.id !== threadId) throw new Error('wrong thread');
      const records: AnyRecord[] = [];
      const seenIds = new Set<string>(), seenCursors = new Set<string>();
      let cursor = page.cursor, index = page.index, visible = 0, bytes = 0;
      const deadline = Date.now() + 15_000;
      do {
        if (records.length >= 2000 || Date.now() > deadline) throw new Error('page budget');
        const result = readObjectRecord(await client.request('thread/items/list', {
          threadId, cursor, limit: 1, sortDirection: page.direction,
        }));
        if (!result || !Array.isArray(result.data) || result.data.length > 1
          || !Object.hasOwn(result, 'nextCursor')) throw new Error('invalid page');
        const next = nextHistoryCursor(result, seenCursors);
        for (const entry of result.data) {
          const item = readObjectRecord(entry.item);
          if (!item || typeof item.id !== 'string' || !item.id || typeof item.type !== 'string'
            || typeof entry.turnId !== 'string' || !entry.turnId || seenIds.has(item.id)
            || typeof result.backwardsCursor !== 'string' || !result.backwardsCursor) throw new Error('invalid item');
          seenIds.add(item.id);
          bytes += Buffer.byteLength(JSON.stringify(entry));
          if (bytes > 16 * 1024 * 1024) throw new Error('page byte budget');
          records.push({
            ...entry, index, orderScope: page.orderScope,
            ascCursor: page.direction === 'asc' ? cursor : result.backwardsCursor,
            descCursor: page.direction === 'desc' ? cursor : result.backwardsCursor,
          });
          index += page.direction === 'asc' ? 1 : -1;
          if (isVisibleItem(item)) visible++;
        }
        if (result.data.length === 0 && next !== null) throw new Error('no progress');
        cursor = next;
      } while (cursor !== null && visible < page.limit && (visible < 2 || bytes < 4 * 1024 * 1024));
      // Only metadata for the turns represented on this page is needed.
      // Native item replies on older daemons do not include timestamps.
      const wanted = new Set(records.map(entry => entry.turnId));
      const turns = new Map<string, AnyRecord>();
      let turnCursor: string | null = null;
      const turnCursors = new Set<string>();
      while (wanted.size) {
        const result = readObjectRecord(await client.request('thread/turns/list', {
          threadId, cursor: turnCursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
        }));
        if (!result || !Array.isArray(result.data) || Date.now() > deadline) throw new Error('invalid turn page');
        for (const turn of result.data) {
          if (wanted.delete(turn.id)) turns.set(turn.id, turn);
        }
        turnCursor = nextHistoryCursor(result, turnCursors);
        if (!wanted.size || turnCursor === null) break;
        if (!result.data.length) throw new Error('no turn progress');
      }
      if (wanted.size) throw new Error('missing visible turn');
      if (client.ownsProcess) {
        const loaded = await client.request('thread/loaded/list', {});
        if (!Array.isArray(loaded.data) || loaded.data.length) throw new Error('reader acquired a writer');
      }
      if (page.direction === 'desc') records.reverse();
      return {
        ...metadata.thread, records: records.map(entry => ({
          ...entry, turnStartedAt: new Date(Number(turns.get(entry.turnId)?.startedAt ?? metadata.thread.createdAt ?? 0) * 1000).toISOString(),
        })),
        more: cursor !== null,
      };
    } catch (error) {
      if (unsupportedMethod(error)) {
        throw new AppError('This Codex runtime does not support native item paging. Update the node runtime.', {
          code: 'CODEX_HISTORY_PAGING_UNSUPPORTED', statusCode: 409,
        });
      }
      throw new AppError('Could not read this native history page. Retry the page without creating another fork.', {
        code: 'CODEX_HISTORY_UNAVAILABLE', statusCode: 502,
      });
    }
  },
  /**
   * Used by CodexSessionsProvider with the selected native connection on every
   * platform. Without a connection, reads through the explicitly configured
   * CLI, never one found in the project/PATH or a guessed JSONL export.
   * No resume/start/fork RPC is permitted and the temporary process must retain
   * an empty loaded-thread list before its snapshot is returned.
   */
  async readThreadSnapshot(
    threadId: string,
    { timeoutMs = 10_000, client, afterPosition, maxItems, isVisibleItem }: {
      timeoutMs?: number; client?: ICodexRpcClient; afterPosition?: NativeTranscriptPosition; maxItems?: number;
      /** Providers ignore non-rendered native items without stalling the visible-row cursor. */
      isVisibleItem?: (item: AnyRecord) => boolean;
    } = {},
  ): Promise<AnyRecord> {
    if (client) {
      try {
        return await readNativeSnapshot((method, params) => client.request(method, params), threadId, Boolean(client.ownsProcess), afterPosition, maxItems, isVisibleItem);
      } catch (error) {
        if (error instanceof AppError && error.code === 'HISTORY_ANCHOR_NOT_FOUND') throw error;
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
      return await withAppServer(({ call }) => readNativeSnapshot(call, threadId, true, afterPosition, maxItems, isVisibleItem), {
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
   * Resolves the `codex` launcher shipped in node_modules.
   *
   * Deliberately not the `codex` on PATH: a machine can have a second, older
   * install, and the protocol this speaks is only guaranteed against the
   * version this package depends on. A property on the exported object
   * rather than a module function so tests can swap in a fake app-server
   * script, the same seam `forkThread` already uses.
   */
  resolveLauncher(): string {
    const require_ = createRequire(import.meta.url);
    try {
      return require_.resolve('@openai/codex/bin/codex.js');
    } catch {
      throw new AppError('The Codex CLI package is not installed, so Codex conversations cannot be branched.', {
        code: 'CODEX_APP_SERVER_UNAVAILABLE',
        statusCode: 501,
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
    /** Only explicit session forks opt in; legacy edit/rewind callers stay guarded. */
    allowNative?: boolean;
  }): Promise<CodexThreadFork> {
    const historyMode = await readCodexHistoryMode(input.threadId);
    if (historyMode && historyMode !== 'legacy') {
      if (input.allowNative) {
        const client = await connectCodexNativeClient();
        if (!client) {
          throw new AppError('Connect the native Codex runtime before forking this session.', {
            code: 'CODEX_DAEMON_REQUIRED', statusCode: 503,
          });
        }
        try {
          // An explicit fork creates a *new* thread. Never resume/interrupt the
          // source, hydrate its whole history, or retry an ambiguous mutation.
          const result = await client.request('thread/fork', {
            threadId: input.threadId, cwd: input.cwd,
            ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
            excludeTurns: true, deferGoalContinuation: true,
          });
          const thread = readObjectRecord(result.thread);
          if (!thread || typeof thread.id !== 'string' || !thread.id || thread.id === input.threadId) {
            throw new AppError('Codex did not confirm an independent fork. The request was not retried.', {
              code: 'FORK_FAILED', statusCode: 502,
            });
          }
          // Native history is authoritative; its JSONL export is optional.
          return { threadId: thread.id, path: typeof thread.path === 'string' ? thread.path : '' };
        } finally {
          await client.close();
        }
      }
      throw new AppError('Fork or edit this native paginated session in Codex app. The legacy Codey fork adapter cannot safely copy its history.', {
        code: 'CODEX_NATIVE_FORK_UNSUPPORTED',
        statusCode: 409,
      });
    }
    return withAppServer(async ({ call }) => {
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

  /**
   * Asks one question on an ephemeral, read-only fork of `threadId` and
   * resolves the concatenated answer. Used by `codexRuntime.askSideQuestion`
   * (`codex-runtime.provider.ts`) to answer a side question without touching
   * the parent thread.
   *
   * `ephemeral: true` keeps the fork off disk; `excludeTurns: true` only
   * leaves `thread.turns` out of the `thread/fork` response — this fork is
   * never listed anywhere, so there is nothing else for it to exclude.
   * `sandbox: 'read-only'` and `approvalPolicy: 'never'` keep it from
   * mutating anything while it has no one to approve a request. The turn
   * itself is the boundary prompt followed by the question, exactly as
   * Codex's own side-conversation support sends it.
   *
   * `config` carries a per-server `enabled: false` for every MCP server
   * `config/read` names, so the fork starts none of them. Measured against
   * the real 0.156.1 binary: `thread/fork`'s `config` deep-merges into the
   * base config rather than replacing a table wholesale, so `{ mcp_servers:
   * {} }` is a no-op — the fork still starts every configured server. Each
   * server does carry an `enabled` field (also seen through `config/read`,
   * not in the generated protocol types), and setting it `false` per name
   * skips that server with no startup attempt at all: no
   * `mcpServer/startupStatus/updated` notification, nothing spawned, nothing
   * dialled. The names come from this same app-server connection rather than
   * from the user's `~/.codex/config.toml` on disk, and only the names are
   * read — never a value, since an MCP entry can carry a token.
   *
   * `config/read` is sent with `cwd: input.cwd`, for the same reason
   * `thread/fork` below gets it: without it the app-server only reads the
   * user-level config, never `<project>/.codex/config.toml` of a trusted
   * project, so a project-only MCP server or app would never be named here
   * and would stay on in the fork. A probe against the real binary showed
   * `config/read {}` omits project entries while `config/read {cwd}` lists
   * them.
   *
   * Three more tools that reach outside the `read-only` sandbox get switched
   * off the same way, each measured against the real 0.156.1 binary with a
   * throwaway `CODEX_HOME` (codex-read-only-tools, second half):
   * - `config: { web_search: 'disabled' }` — `Config.web_search` is a
   *   `WebSearchMode`; `thread/start`/`thread/fork` accept `'disabled'`
   *   without error, and an invalid value (`'nope'`) is rejected with
   *   "unknown variant `nope`, expected one of `disabled`, `cached`,
   *   `indexed`, `live`", so the field is real and the value lands.
   * - `config: { apps: { _default: { enabled: false }, ...per-app } }` —
   *   `AppsConfig`'s `_default: AppsDefaultConfig | null` is the fallback
   *   applied to every connector that has no per-app entry, and `enabled:
   *   false` there is accepted (while `enabled: 'nope'` is rejected with
   *   "invalid type: string \"nope\", expected a boolean in
   *   `apps._default.enabled`", proof the override reaches that exact
   *   field). `_default` alone is not enough: `app_is_enabled`
   *   (codex-rs/connectors/src/app_tool_policy.rs:107 at rust-v0.166.0)
   *   prefers a per-app `[apps.<id>]` entry over `_default` when one exists,
   *   and `AppConfig.enabled` defaults to `true` — so a user's own `github`
   *   table, with or without an explicit `enabled` key, would keep that
   *   connector on in the fork unless every app name `config/read` reports
   *   also gets its own `enabled: false`.
   * - `disabledPluginIds` on the `turn/start` below — `plugin/list` needs no
   *   auth offline and lists every installed marketplace's plugins;
   *   `TurnStartParams.disabledPluginIds` "replaces this thread's disabled
   *   plugin IDs", so every id it reports is passed there. A `plugin/list`
   *   that errors (or would need auth) is treated as "no plugins" rather
   *   than failing the side question — nothing is disabled that could not be
   *   named, but the question still gets asked.
   * - `config: { features: { plugins: false } }` — the app-server README
   *   says of `disabledPluginIds` "Saving this selection does not yet filter
   *   plugin capabilities", and a probe against the real 0.166.0 binary
   *   (throwaway `CODEX_HOME`, one local plugin shipping an MCP server and a
   *   skill) showed why that matters: with `disabledPluginIds` alone the
   *   plugin's tool and skill stayed out of the fork's model request, but its
   *   MCP server process still started in the fork. With this override the
   *   fork started no plugin MCP server, exposed no plugin tool and injected
   *   no plugin skill, with or without `disabledPluginIds`, while the parent
   *   thread kept all three. It is the master switch the fork's own config
   *   reads (`Feature::Plugins`, which `PluginsManager::plugins_for_config`
   *   checks first), so it needs no plugin ids and also holds when
   *   `plugin/list` fails. `plugins: { _default: { enabled: false } }`
   *   alone did not stop the server: a per-plugin `enabled = true`, which
   *   `plugin/install` writes, overrides `_default` (`allows_plugin`,
   *   codex-rs/config/src/types.rs at rust-v0.166.0).
   */
  async askSideQuestion(
    input: { threadId: string; cwd: string; model: string; question: string; signal: AbortSignal },
    onDelta: (text: string) => void,
  ): Promise<string> {
    const abortedError = () => new AppError('The side question was aborted.', {
      code: 'CODEX_SIDE_QUESTION_ABORTED',
      statusCode: 499,
    });

    if (input.signal.aborted) {
      throw abortedError();
    }

    return withAppServer(async ({ call, onNotification, onExit }) => {
      // Reads the config layer stack the same way `thread/fork` below will
      // see it — `cwd` is what makes `config/read` fold in the project
      // layer — and turns each MCP server and app it names off by name, the
      // way the doc comment above explains.
      const configOverridesOff = async (): Promise<{
        mcpServers: Record<string, unknown>;
        apps: Record<string, unknown>;
      }> => {
        const configResult = await call('config/read', input.cwd ? { cwd: input.cwd } : {}) as {
          config?: { mcp_servers?: Record<string, unknown>; apps?: Record<string, unknown> };
        } | undefined;
        const mcpServerNames = Object.keys(configResult?.config?.mcp_servers ?? {});
        const appNames = Object.keys(configResult?.config?.apps ?? {});
        return {
          mcpServers: Object.fromEntries(mcpServerNames.map((name) => [name, { enabled: false }])),
          apps: Object.fromEntries(
            [...new Set([...appNames, '_default'])].map((name) => [name, { enabled: false }]),
          ),
        };
      };

      // `plugin/list` can fail offline (no auth, no network) and that is not
      // a reason to refuse the side question — it just means there is
      // nothing to name in `disabledPluginIds`, same as a user with no
      // plugins installed.
      const pluginIdsOff = async (): Promise<string[]> => {
        try {
          const result = await call('plugin/list', {}) as {
            marketplaces?: Array<{ plugins?: Array<{ id?: unknown }> }>;
          } | undefined;
          const ids: string[] = [];
          for (const marketplace of result?.marketplaces ?? []) {
            for (const plugin of marketplace.plugins ?? []) {
              if (typeof plugin?.id === 'string') {
                ids.push(plugin.id);
              }
            }
          }
          return ids;
        } catch {
          return [];
        }
      };

      return new Promise<string>((resolve, reject) => {
        let text = '';
        // Deltas are optional and `item/completed` is the final item, so an
        // agent message that never streamed is taken from there instead.
        const streamedItemIds = new Set<string>();
        // Codex often writes a progress note ("I'll read math.js…") and the
        // answer as two agentMessage items. A new item id after text already
        // sent starts a new paragraph. A delta without an item id is taken as
        // part of the current item: a seam guessed wrong would split a word.
        let currentItemId: string | null = null;
        const appendAgentText = (itemId: string | null, chunk: string) => {
          if (text && itemId !== null && currentItemId !== null && itemId !== currentItemId) {
            text += SIDE_QUESTION_ANSWER_SEPARATOR;
            onDelta(SIDE_QUESTION_ANSWER_SEPARATOR);
          }
          if (itemId !== null) {
            currentItemId = itemId;
          }
          text += chunk;
          onDelta(chunk);
        };
        let settled = false;
        let removeNotificationListener: (() => void) | null = null;
        let removeExitListener: (() => void) | null = null;

        const timer = setTimeout(() => {
          settle(() => reject(new AppError(
            `Codex side question did not complete within ${SIDE_QUESTION_TURN_TIMEOUT_MS}ms.`,
            { code: 'CODEX_SIDE_QUESTION_TIMEOUT', statusCode: 504 },
          )));
        }, SIDE_QUESTION_TURN_TIMEOUT_MS);

        const onAbort = () => {
          settle(() => reject(abortedError()));
        };
        // Attached before `config/read` and `thread/fork` go out, so a
        // dismiss while they are in flight is caught the same way as one
        // during the turn itself. A dismiss during `initialize`, before this
        // runs, is `withAppServer`'s: it kills the child.
        input.signal.addEventListener('abort', onAbort);

        function settle(action: () => void) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          input.signal.removeEventListener('abort', onAbort);
          removeNotificationListener?.();
          removeExitListener?.();
          action();
        }

        if (input.signal.aborted) {
          settle(() => reject(abortedError()));
          return;
        }

        let pluginIds: string[] = [];

        Promise.all([configOverridesOff(), pluginIdsOff()]).then(([{ mcpServers, apps }, ids]) => {
          pluginIds = ids;
          if (settled) {
            // Aborted, or already timed out, while config/read or
            // plugin/list was in flight.
            return;
          }
          return call('thread/fork', {
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            ephemeral: true,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            developerInstructions: SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
            excludeTurns: true,
            config: {
              mcp_servers: mcpServers,
              web_search: 'disabled',
              apps,
              features: { plugins: false },
            },
          });
        }).then((forkResult) => {
          if (settled) {
            // Aborted, or already timed out, while the fork request was in flight.
            return;
          }

          const typedForkResult = forkResult as { thread?: { id?: unknown } } | undefined;
          const forkThreadId = typeof typedForkResult?.thread?.id === 'string' ? typedForkResult.thread.id : '';
          if (!forkThreadId) {
            settle(() => reject(new AppError('Codex reported a side-question fork without a thread id.', {
              code: 'FORK_FAILED',
              statusCode: 502,
            })));
            return;
          }

          // From here on the turn waiter sits on a notification, not a
          // pending `call()`, so a child that exits mid-turn would otherwise
          // only be noticed once `SIDE_QUESTION_TURN_TIMEOUT_MS` elapses.
          removeExitListener = onExit((reason) => {
            settle(() => reject(new AppError(
              `Codex exited before the side-question turn finished (${reason}).`,
              { code: 'CODEX_SIDE_QUESTION_FAILED', statusCode: 502 },
            )));
          });

          removeNotificationListener = onNotification((method, params) => {
            const notificationParams = params as {
              threadId?: unknown;
              itemId?: unknown;
              delta?: unknown;
              item?: { type?: unknown; id?: unknown; text?: unknown };
              turn?: { status?: unknown; error?: { message?: unknown } };
            } | undefined;
            // Another thread's deltas (e.g. the one this fork was copied from)
            // arrive on the same connection; only this fork's own notifications
            // belong to this question.
            if (notificationParams?.threadId !== forkThreadId) {
              return;
            }

            if (method === 'item/agentMessage/delta') {
              const delta = typeof notificationParams.delta === 'string' ? notificationParams.delta : '';
              if (delta) {
                const itemId = typeof notificationParams.itemId === 'string' ? notificationParams.itemId : null;
                if (itemId !== null) {
                  streamedItemIds.add(itemId);
                }
                appendAgentText(itemId, delta);
              }
              return;
            }

            if (method === 'item/completed') {
              const item = notificationParams.item;
              if (
                item?.type === 'agentMessage'
                && typeof item.text === 'string' && item.text
                && !(typeof item.id === 'string' && streamedItemIds.has(item.id))
              ) {
                appendAgentText(typeof item.id === 'string' ? item.id : null, item.text);
              }
              return;
            }

            if (method === 'turn/completed') {
              const status = notificationParams.turn?.status;
              if (status === 'completed') {
                settle(() => resolve(text));
                return;
              }
              const message = typeof notificationParams.turn?.error?.message === 'string'
                ? notificationParams.turn.error.message
                : `Codex side-question turn ${String(status)}.`;
              settle(() => reject(new AppError(message, { code: 'CODEX_SIDE_QUESTION_FAILED', statusCode: 502 })));
            }
          });

          if (settled) {
            return;
          }

          call('turn/start', {
            threadId: forkThreadId,
            disabledPluginIds: pluginIds,
            input: [
              { type: 'text', text: SIDE_CONVERSATION_BOUNDARY_PROMPT, text_elements: [] },
              { type: 'text', text: input.question, text_elements: [] },
            ],
          }).catch((error) => {
            settle(() => reject(error));
          });
        }).catch((error) => {
          settle(() => reject(error));
        });
      });
    }, { kind: 'legacy-fork' }, input.signal).catch((error: unknown) => {
      // A dismiss during `initialize` surfaces as the killed child's exit;
      // report it as the abort it was.
      throw input.signal.aborted ? abortedError() : error;
    });
  },
};
