import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocketServer, type WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { CodexThreadStatusWatcher, codexThreadStatus } from '@/modules/providers/list/codex/codex-thread-status.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const unixOnly = { skip: process.platform === 'win32' };

/**
 * A daemon on a Unix socket: answers `thread/loaded/list` and `thread/read`
 * from `threads` (id -> status), and lets the test push notifications.
 */
async function fakeDaemon(threads: Record<string, unknown>) {
  // /tmp directly, to stay below Darwin's Unix-socket pathname limit.
  const home = await mkdtemp('/tmp/codey-status-');
  const socketPath = path.join(home, 'daemon.sock');
  const server = http.createServer();
  const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  const methods: string[] = [];
  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(String(raw));
      methods.push(request.method);
      if (request.id === undefined) return;
      const result = request.method === 'thread/loaded/list' ? { data: Object.keys(threads), nextCursor: null }
        : request.method === 'thread/read' ? { thread: { id: request.params.threadId, status: threads[request.params.threadId] } }
          : {};
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return {
    methods,
    connections: () => [...sockets.clients] as WebSocket[],
    notify(method: string, params: unknown) {
      for (const socket of sockets.clients) socket.send(JSON.stringify({ method, params }));
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
    socketPath,
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('the watcher follows every thread of the daemon without subscribing to any', unixOnly, async () => {
  const daemon = await fakeDaemon({
    'thread-asking': { type: 'active', activeFlags: ['waitingOnApproval'] },
    'thread-idle': { type: 'idle' },
  });
  let now = 1_000;
  let changes = 0;
  const watcher = new CodexThreadStatusWatcher({
    connect: () => CodexDaemonClient.connect({ socketPath: daemon.socketPath, timeoutMs: 1_000 }),
    now: () => now,
    retryMs: [20],
  });
  watcher.onChange(() => { changes += 1; });
  try {
    watcher.start();
    await until(() => watcher.busyThreads().length === 1, 'the loaded threads');
    assert.deepEqual(watcher.busyThreads(), [{ threadId: 'thread-asking', startedAt: 1_000, waitingKind: 'permission' }]);
    assert.deepEqual(daemon.methods.slice(0, 3), ['initialize', 'initialized', 'thread/loaded/list']);
    assert.ok(!daemon.methods.some((method) => method.includes('subscribe') || method === 'thread/resume'));

    // A turn another client starts, asks a question in, and finishes.
    now = 2_000;
    daemon.notify('thread/started', { thread: { id: 'thread-new', status: { type: 'active', activeFlags: [] } } });
    await until(() => watcher.busyThreads().length === 2, 'the started thread');
    now = 3_000;
    daemon.notify('thread/status/changed', { threadId: 'thread-new', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
    await until(() => watcher.busyThreads().some((thread) => thread.waitingKind === 'question'), 'the question');
    assert.deepEqual(watcher.busyThreads().find((thread) => thread.threadId === 'thread-new'),
      { threadId: 'thread-new', startedAt: 2_000, waitingKind: 'question' }, 'waiting keeps when the turn began');
    daemon.notify('thread/status/changed', { threadId: 'thread-new', status: { type: 'idle' } });
    await until(() => watcher.busyThreads().length === 1, 'the finished turn');
    assert.equal(watcher.outcomeOf('thread-new'), null);

    // A turn that stops on an error, and the next turn that clears it.
    daemon.notify('thread/status/changed', { threadId: 'thread-asking', status: { type: 'systemError' } });
    await until(() => watcher.busyThreads().length === 0, 'the failed turn');
    assert.equal(watcher.outcomeOf('thread-asking'), 'failed');
    daemon.notify('thread/status/changed', { threadId: 'thread-asking', status: { type: 'active', activeFlags: [] } });
    await until(() => watcher.busyThreads().length === 1, 'the next turn');
    assert.equal(watcher.outcomeOf('thread-asking'), null);
    const counted = changes;
    daemon.notify('thread/status/changed', { threadId: 'thread-asking', status: { type: 'active', activeFlags: [] } });
    daemon.notify('thread/tokenUsage/updated', { threadId: 'thread-asking' });
    daemon.notify('thread/status/changed', { threadId: 42, status: 'nonsense' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(changes, counted, 'repeats and noise change nothing');

    // The daemon going away forgets its threads; the watcher connects again.
    for (const socket of daemon.connections()) socket.terminate();
    await until(() => watcher.busyThreads().length === 0, 'the dropped connection');
    await until(() => daemon.methods.filter((method) => method === 'initialize').length === 2, 'the reconnection');
    await until(() => watcher.busyThreads().length === 1, 'the loaded threads again');
  } finally {
    watcher.close();
    await daemon.close();
  }
});

test('without a daemon the watcher keeps trying, quietly', async () => {
  let attempts = 0;
  const watcher = new CodexThreadStatusWatcher({
    connect: async () => { attempts += 1; return null; },
    now: Date.now,
    retryMs: [10, 20],
  });
  watcher.start();
  await until(() => attempts >= 3, 'the retries');
  watcher.close();
  const stoppedAt = attempts;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(attempts, stoppedAt, 'closing stops the retries');
  assert.deepEqual(watcher.busyThreads(), []);
});

/** An empty database, and a home without this machine's own Claude processes. */
async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp('/tmp/codey-status-db-');
  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => directory;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await run();
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('the running list shows Codex app turns, and a waiting thread marks the run CloudCLI drives there', { concurrency: false }, async (t) => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('thread-desktop', 'codex', '/tmp/running-project');
    sessionsDb.createAppSession('app-session', 'codex', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('app-session', 'thread-driven');
    sessionsDb.createSession('claude-native', 'claude', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-session', provider: 'codex', providerSessionId: 'thread-driven', connection: null, userId: null,
    });
    assert.ok(run);
    t.after(() => chatRunRegistry.clearAll());
    t.mock.method(codexThreadStatus, 'busyThreads', () => [
      { threadId: 'thread-desktop', startedAt: 7_000 },
      { threadId: 'thread-driven', startedAt: 8_000, waitingKind: 'permission' },
      { threadId: 'thread-unknown', startedAt: 9_000 },
      { threadId: 'claude-native', startedAt: 9_000 },
    ]);

    const entries = await sessionsService.listRunningSessions();
    assert.deepEqual(entries.find((entry) => entry.sessionId === 'app-session'), {
      sessionId: 'app-session', provider: 'codex', startedAt: run.startedAt, lastSeq: 0,
      waitingForUser: true, waitingKind: 'permission',
    });
    assert.deepEqual(entries.find((entry) => entry.sessionId === 'thread-desktop'), {
      sessionId: 'thread-desktop', provider: 'codex', startedAt: 7_000, lastSeq: 0,
      canInterrupt: false, statusText: 'Running in the Codex app',
    });
    assert.equal(entries.length, 2, 'threads without a Codex session here are left out');
  });
});
