import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import Database from 'better-sqlite3';
import WebSocket, { WebSocketServer } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { CodexSessionSynchronizer, synchronizeCodexDaemonSessions } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

const THREAD_ID = 'desktop-thread';
const APP_ID = 'app-session';
const CREATED_AT = 1_788_695_682;
let databaseTemplateDirectory: string | null = null;

after(async () => {
  if (databaseTemplateDirectory) await rm(databaseTemplateDirectory, { recursive: true, force: true });
});

const history = [{
  id: 'turn-old', status: 'completed', startedAt: CREATED_AT,
  items: [
    { id: 'user-old', type: 'userMessage', content: [{ type: 'text', text: 'Original desktop prompt' }] },
    { id: 'reply-old', type: 'agentMessage', text: 'Original desktop reply' },
    {
      id: 'shell-old', type: 'commandExecution', command: 'pwd',
      status: 'completed', aggregatedOutput: '/workspace/demo', exitCode: 0,
    },
  ],
}];

function reply(socket: WebSocket, request: AnyRecord, result: AnyRecord): void {
  socket.send(JSON.stringify({ id: request.id, result }));
}

function event(socket: WebSocket, method: string, params: AnyRecord): void {
  socket.send(JSON.stringify({ method, params: { threadId: THREAD_ID, turnId: 'turn-new', ...params } }));
}

async function withFixture(
  run: (fixture: { root: string; home: string; requests: AnyRecord[]; fallbackCalls: string[]; fallback: IProviderRuntime }) => Promise<void>,
  handle?: (request: AnyRecord, socket: WebSocket) => boolean,
  withDaemon = true,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codey-daemon-'));
  const home = path.join(root, 'codex');
  const previousHome = process.env.CODEX_HOME;
  const previousDatabase = process.env.DATABASE_PATH;
  const requests: AnyRecord[] = [];
  const fallbackCalls: string[] = [];
  const fallback: IProviderRuntime = {
    run: async (command) => { fallbackCalls.push(command); },
    abort: () => false,
  };
  const http = createServer();
  const wsServer = new WebSocketServer({ server: http });
  try {
    await mkdir(path.join(home, 'app-server-control'), { recursive: true });
    process.env.CODEX_HOME = home;
    process.env.DATABASE_PATH = path.join(root, 'auth.db');
    closeConnection();
    if (!databaseTemplateDirectory) {
      // These test sessions, not password hashing. Checkpoint a fully
      // initialized empty database once, then give every case its own copy.
      await initializeDatabase();
      closeConnection();
      databaseTemplateDirectory = await mkdtemp(path.join(os.tmpdir(), 'codey-daemon-db-template-'));
      await copyFile(process.env.DATABASE_PATH, path.join(databaseTemplateDirectory, 'auth.db'));
    } else {
      await copyFile(path.join(databaseTemplateDirectory, 'auth.db'), process.env.DATABASE_PATH);
    }
    if (withDaemon) {
      wsServer.on('connection', (socket) => {
        socket.on('message', (data) => {
          const request = JSON.parse(String(data)) as AnyRecord;
          requests.push(request);
          if (!request.id) return;
          if (handle?.(request, socket)) return;
          if (request.method === 'initialize') {
            reply(socket, request, { userAgent: 'test-daemon', codexHome: home });
          } else if (request.method === 'thread/list') {
            reply(socket, request, {
              data: [{
                id: THREAD_ID, name: 'Desktop-only session', source: 'vscode',
                cwd: '/workspace/demo', createdAt: CREATED_AT, updatedAt: CREATED_AT,
                // No JSONL exists for this paginated thread.
                path: path.join(home, 'sessions', 'not-exported.jsonl'),
              }],
              nextCursor: null,
            });
          } else if (request.method === 'thread/read') {
            reply(socket, request, { thread: { id: THREAD_ID, createdAt: CREATED_AT, turns: history } });
          } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
            reply(socket, request, { thread: { id: THREAD_ID, status: { type: 'idle' } } });
          } else if (request.method === 'turn/start') {
            // Events can precede the RPC acknowledgement. Another thread's
            // events must never be rendered as part of this run.
            event(socket, 'item/completed', {
              threadId: 'other-thread', item: { id: 'foreign', type: 'agentMessage', text: 'DO NOT SHOW' },
            });
            event(socket, 'item/started', { item: { id: 'reply-new', type: 'agentMessage', text: '' } });
            event(socket, 'item/agentMessage/delta', { itemId: 'reply-new', delta: 'Hello' });
            event(socket, 'item/completed', { item: { id: 'reply-new', type: 'agentMessage', text: 'Hello from shared owner' } });
            event(socket, 'turn/completed', { turn: { id: 'turn-new', status: 'completed' } });
            reply(socket, request, { turn: { id: 'turn-new', status: 'inProgress' } });
          } else {
            reply(socket, request, {});
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(path.join(home, 'app-server-control', 'app-server-control.sock'), resolve);
      });
    }
    await run({ root, home, requests, fallbackCalls, fallback });
  } finally {
    for (const socket of wsServer.clients) socket.terminate();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
    closeConnection();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    await rm(root, { recursive: true, force: true });
  }
}

function executionContext(): { messages: AnyRecord[]; writer: ProviderRuntimeWriter; context: ProviderRuntimeContext } {
  const messages: AnyRecord[] = [];
  const provider = new CodexSessionsProvider();
  return {
    messages,
    writer: { isWebSocketWriter: true, send: (message) => messages.push(message as AnyRecord) },
    context: {
      resolveProviderSessionId: () => THREAD_ID,
      resolveResumeModel: async () => 'unchanged-model',
      getProviderModels: async () => ({ DEFAULT: 'unchanged-model', OPTIONS: [] }),
      normalizeMessage: (raw, sessionId) => provider.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
    },
  };
}

test('native discovery indexes a desktop session without JSONL and coalesces concurrent scans', { concurrency: false }, async () => {
  await withFixture(async ({ requests }) => {
    const [first, second] = await Promise.all([synchronizeCodexDaemonSessions(), synchronizeCodexDaemonSessions()]);
    assert.deepEqual(first.changed, [THREAD_ID]);
    assert.deepEqual(second.changed, [THREAD_ID]);
    assert.equal(requests.filter((request) => request.method === 'thread/list').length, 1);
    const row = sessionsDb.getSessionById(THREAD_ID);
    assert.equal(row?.custom_name, 'Desktop-only session');
    assert.equal(row?.jsonl_path, null);
    assert.equal(row?.project_path, '/workspace/demo');
    assert.deepEqual((await synchronizeCodexDaemonSessions()).changed, []);
    assert.ok(!requests.some((request) => request.method === 'thread/resume'));
  });
});

test('native discovery preserves app/provider mapping and existing app title', { concurrency: false }, async () => {
  await withFixture(async () => {
    sessionsDb.createAppSession(APP_ID, 'codex', '/workspace/demo', 'My Codey title');
    sessionsDb.assignProviderSessionId(APP_ID, THREAD_ID);
    await new CodexSessionSynchronizer().synchronize(new Date());
    assert.equal(sessionsDb.getSessionById(APP_ID)?.custom_name, 'My Codey title');
    assert.equal(sessionsDb.getSessionById(THREAD_ID), null);
    assert.deepEqual((await synchronizeCodexDaemonSessions()).changed, []);
  });
});

test('native polling preserves local renames and archives', { concurrency: false }, async () => {
  await withFixture(async () => {
    await synchronizeCodexDaemonSessions();
    sessionsDb.updateSessionCustomName(THREAD_ID, 'Renamed in Codey');
    assert.deepEqual((await synchronizeCodexDaemonSessions()).changed, []);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'Renamed in Codey');
    sessionsDb.updateSessionIsArchived(THREAD_ID, true);
    assert.deepEqual((await synchronizeCodexDaemonSessions()).changed, []);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.isArchived, 1);
  });
});

test('native polling does not resurrect a conversation removed from the Codey index', { concurrency: false }, async () => {
  await withFixture(async () => {
    await synchronizeCodexDaemonSessions();
    const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
    await sessionsService.deleteOrArchiveSessionById(THREAD_ID, { force: true, deletedFromDisk: false });
    await synchronizeCodexDaemonSessions();
    assert.equal(sessionsDb.getSessionById(THREAD_ID), null);
  });
});

test('native permanent deletion is not implemented by unlinking its JSONL export', { concurrency: false }, async () => {
  await withFixture(async ({ home }) => {
    const db = new Database(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    db.close();
    await synchronizeCodexDaemonSessions();
    const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
    await assert.rejects(sessionsService.deleteOrArchiveSessionById(THREAD_ID, { force: true, deletedFromDisk: true }), /Permanently delete.*in Codex app/);
    assert.ok(sessionsDb.getSessionById(THREAD_ID));
  });
});

test('paginated history is read from the owner without acquiring a writer', { concurrency: false }, async () => {
  await withFixture(async ({ requests }) => {
    sessionsDb.createAppSession(APP_ID, 'codex', '/workspace/demo', 'Desktop session');
    sessionsDb.assignProviderSessionId(APP_ID, THREAD_ID);
    const provider = new CodexSessionsProvider();
    const first = await provider.fetchHistory(APP_ID, { providerSessionId: THREAD_ID });
    const second = await provider.fetchHistory(APP_ID, { providerSessionId: THREAD_ID });
    assert.ok(first.messages.some((message) => message.content === 'Original desktop prompt'));
    assert.ok(first.messages.some((message) => message.content === 'Original desktop reply'));
    assert.ok(first.messages.every((message) => !message.transcriptAnchorId));
    assert.ok(first.messages.some((message) => message.toolName === 'Bash' && message.toolResult?.content === '/workspace/demo'));
    assert.deepEqual(first.messages.map((message) => message.id), second.messages.map((message) => message.id));
    assert.ok(!requests.some((request) => request.method === 'thread/resume'));
    assert.ok(requests.filter((request) => request.method === 'thread/read').every((request) => request.params.threadId === THREAD_ID));
  });
});

test('native history bypasses the legacy JSONL cache when the export does not change', { concurrency: false }, async () => {
  let reads = 0;
  await withFixture(async ({ home }) => {
    const db = new Database(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    db.close();
    const exported = path.join(home, 'unchanged-export.jsonl');
    await writeFile(exported, '{}\n');
    sessionsDb.createSession(THREAD_ID, 'codex', '/workspace/demo', 'Native history', undefined, undefined, exported);
    const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
    const first = await sessionsService.fetchHistory(THREAD_ID);
    const second = await sessionsService.fetchHistory(THREAD_ID);
    assert.equal(reads, 2);
    assert.ok(first.messages.some((message) => message.content === 'Revision 1'));
    assert.ok(second.messages.some((message) => message.content === 'Revision 2'));
  }, (request, socket) => {
    if (request.method !== 'thread/read') return false;
    reads++;
    reply(socket, request, { thread: {
      id: THREAD_ID, createdAt: CREATED_AT,
      turns: [{ id: 'turn-old', startedAt: CREATED_AT, items: [{ id: 'reply-old', type: 'agentMessage', text: `Revision ${reads}` }] }],
    } });
    return true;
  });
});

test('resume uses the existing daemon and buffers early turn events without starting exec', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Continue here', { sessionId: APP_ID, projectPath: '/workspace/demo' }, writer, context);
    assert.deepEqual(fallbackCalls, []);
    const resumes = requests.filter((request) => request.method === 'thread/resume');
    assert.equal(resumes.length, 1);
    assert.deepEqual(resumes[0].params, { threadId: THREAD_ID, excludeTurns: true });
    const starts = requests.filter((request) => request.method === 'turn/start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.threadId, THREAD_ID);
    assert.equal(starts[0].params.input[0].text, 'Continue here');
    assert.ok(!('approvalPolicy' in starts[0].params));
    assert.ok(messages.some((message) => message.id === 'reply-new' && message.content === 'Hello from shared owner'));
    assert.ok(!messages.some((message) => message.content === 'DO NOT SHOW'));
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.at(-1)?.success, true);
  });
});

test('new web sessions are created by the shared daemon and mapped before their first turn', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    sessionsDb.createAppSession(APP_ID, 'codex', '/workspace/demo', 'New Codey session');
    context.resolveProviderSessionId = () => sessionsDb.getSessionById(APP_ID)?.provider_session_id ?? null;
    writer.setSessionId = (id) => sessionsDb.assignProviderSessionId(APP_ID, id);
    await new CodexSharedRuntime(fallback).run('First prompt', {
      sessionId: APP_ID, projectPath: '/workspace/demo',
    }, writer, context);
    assert.deepEqual(fallbackCalls, []);
    assert.equal(sessionsDb.getSessionById(APP_ID)?.provider_session_id, THREAD_ID);
    const starts = requests.filter((request) => request.method === 'thread/start');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].params, {
      cwd: '/workspace/demo', model: 'unchanged-model',
      sandbox: 'workspace-write', approvalPolicy: 'untrusted',
    });
    assert.equal(requests.find((request) => request.method === 'initialize')?.params.clientInfo.name, 'cloudcli');
    assert.ok(!requests.some((request) => request.method === 'thread/resume' || request.method === 'thread/fork'));
    assert.equal(requests.find((request) => request.method === 'turn/start')?.params.threadId, THREAD_ID);
    assert.equal(messages[0].kind, 'session_created');
    assert.equal(messages[0].newSessionId, THREAD_ID);
    assert.equal(messages.at(-1)?.success, true);

    // A subsequent message must resume the native id, never create another.
    await new CodexSharedRuntime(fallback).run('Second prompt', { sessionId: APP_ID }, writer, context);
    assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1);
    assert.equal(requests.find((request) => request.method === 'thread/resume')?.params.threadId, THREAD_ID);
  });
});

test('new daemon sessions honor Codey permission choices without changing existing threads', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback }) => {
    const { writer, context } = executionContext();
    context.resolveProviderSessionId = () => null;
    const runtime = new CodexSharedRuntime(fallback);
    await runtime.run('Allow edits', { sessionId: APP_ID, permissionMode: 'acceptEdits' }, writer, context);
    await runtime.run('Full access', { sessionId: APP_ID, permissionMode: 'bypassPermissions' }, writer, context);
    assert.deepEqual(requests.filter((request) => request.method === 'thread/start').map((request) => ({
      sandbox: request.params.sandbox, approvalPolicy: request.params.approvalPolicy,
    })), [
      { sandbox: 'workspace-write', approvalPolicy: 'never' },
      { sandbox: 'danger-full-access', approvalPolicy: 'never' },
    ]);
    assert.ok(requests.filter((request) => request.method === 'turn/start')
      .every((request) => !('approvalPolicy' in request.params) && !('sandboxPolicy' in request.params)));
  });
});

test('failed daemon thread creation is not retried with exec', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    context.resolveProviderSessionId = () => null;
    await new CodexSharedRuntime(fallback).run('Create once', { sessionId: APP_ID }, writer, context);
    assert.deepEqual(fallbackCalls, []);
    assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1);
    assert.ok(!requests.some((request) => request.method === 'turn/start'));
    assert.equal(messages.at(-1)?.success, false);
  }, (request, socket) => {
    if (request.method !== 'thread/start') return false;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Thread creation rejected' } }));
    return true;
  });
});

test('new sessions still support legacy CLI-only installations without a daemon', { concurrency: false }, async () => {
  await withFixture(async ({ fallback, fallbackCalls }) => {
    const { writer, context } = executionContext();
    context.resolveProviderSessionId = () => null;
    await new CodexSharedRuntime(fallback).run('New legacy session', { sessionId: APP_ID }, writer, context);
    assert.deepEqual(fallbackCalls, ['New legacy session']);
  }, undefined, false);
});

test('a busy desktop turn is not interrupted or appended to by Codey', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Wait for me', { sessionId: APP_ID }, writer, context);
    assert.equal(messages.at(-1)?.success, false);
    assert.match(messages.find((message) => message.kind === 'error')?.content, /currently running in Codex app/);
    assert.ok(!requests.some((request) => request.method === 'turn/start' || request.method === 'turn/interrupt'));
    assert.deepEqual(fallbackCalls, []);
  }, (request, socket) => {
    if (request.method !== 'thread/resume') return false;
    reply(socket, request, { thread: { id: THREAD_ID, status: { type: 'active' } } });
    return true;
  });
});

test('a browser writer error does not turn completed daemon work into a failed or retried run', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback }) => {
    const { messages, writer, context } = executionContext();
    const connectedSend = writer.send;
    writer.send = (message) => {
      if ((message as AnyRecord).kind === 'text') throw new Error('Browser disconnected');
      connectedSend(message);
    };
    await new CodexSharedRuntime(fallback).run('Continue in the daemon', { sessionId: APP_ID }, writer, context);
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.equal(messages.at(-1)?.success, true);
    assert.ok(!requests.some((request) => request.method === 'turn/interrupt'));
  });
});

test('writer conflicts are actionable and never trigger an exec fallback or fork', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Keep same thread', { sessionId: APP_ID }, writer, context);
    assert.match(messages.find((message) => message.kind === 'error')?.content, /owned by another Codex process/);
    assert.deepEqual(fallbackCalls, []);
    assert.ok(!requests.some((request) => request.method === 'thread/fork' || request.method === 'turn/start'));
  }, (request, socket) => {
    if (request.method !== 'thread/resume') return false;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: `thread-store conflict: thread ${THREAD_ID} already has an active writer` } }));
    return true;
  });
});

test('disconnect after accepting a turn is reported without resubmitting it', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Exactly once', { sessionId: APP_ID }, writer, context);
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.deepEqual(fallbackCalls, []);
    assert.equal(messages.at(-1)?.success, false);
    assert.match(messages.find((message) => message.kind === 'error')?.content, /not retried/);
  }, (request, socket) => {
    if (request.method !== 'turn/start') return false;
    reply(socket, request, { turn: { id: 'turn-new', status: 'inProgress' } });
    socket.close();
    return true;
  });
});

test('paginated sessions fail safely without a daemon, while legacy SDK sessions still work', { concurrency: false }, async () => {
  await withFixture(async ({ home, fallback, fallbackCalls }) => {
    const db = new Database(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    db.close();
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Do not use exec', { sessionId: APP_ID }, writer, context);
    assert.deepEqual(fallbackCalls, []);
    assert.match(messages.find((message) => message.kind === 'error')?.content, /paginated history/);
    context.resolveProviderSessionId = () => 'legacy-thread';
    await new CodexSharedRuntime(fallback).run('Legacy still works', { sessionId: 'legacy-app' }, writer, context);
    assert.deepEqual(fallbackCalls, ['Legacy still works']);
  }, undefined, false);
});

test('an existing legacy lock file is not treated as proof of an active writer', { concurrency: false }, async () => {
  await withFixture(async ({ home, fallback, fallbackCalls }) => {
    await mkdir(path.join(home, 'thread-writer-locks'));
    await writeFile(path.join(home, 'thread-writer-locks', `${THREAD_ID}.lock`), '');
    const { writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Resume legacy', { sessionId: APP_ID }, writer, context);
    assert.deepEqual(fallbackCalls, ['Resume legacy']);
  }, undefined, false);
});

test('a partial paginated JSONL export is never presented as complete history when the daemon is absent', { concurrency: false }, async () => {
  await withFixture(async ({ home }) => {
    const db = new Database(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    db.close();
    const partial = path.join(home, 'partial.jsonl');
    await writeFile(partial, JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID, cwd: '/workspace/demo' } }) + '\n');
    sessionsDb.createSession(THREAD_ID, 'codex', '/workspace/demo', 'Native session', undefined, undefined, partial);
    await assert.rejects(new CodexSessionsProvider().fetchHistory(THREAD_ID), /Connect its local daemon/);
  }, undefined, false);
});

test('abort interrupts only the turn Codey started through the daemon', { concurrency: false }, async () => {
  let started!: () => void;
  const accepted = new Promise<void>((resolve) => { started = resolve; });
  await withFixture(async ({ requests, fallback }) => {
    const { writer, context } = executionContext();
    const runtime = new CodexSharedRuntime(fallback);
    const running = runtime.run('Run until interrupted', { sessionId: APP_ID }, writer, context);
    await accepted;
    // Abort may race with the start acknowledgement; it must still target
    // the acknowledged turn, never some other desktop turn on this thread.
    assert.equal(await runtime.abort(APP_ID), true);
    await running;
    assert.deepEqual(requests.find((request) => request.method === 'turn/interrupt')?.params, {
      threadId: THREAD_ID, turnId: 'turn-new',
    });
  }, (request, socket) => {
    if (request.method === 'turn/start') {
      reply(socket, request, { turn: { id: 'turn-new', status: 'inProgress' } });
      started();
      return true;
    }
    if (request.method === 'turn/interrupt') {
      reply(socket, request, {});
      event(socket, 'turn/completed', { turn: { id: 'turn-new', status: 'interrupted' } });
      return true;
    }
    return false;
  });
});

test('desktop approval requests are surfaced without automatically approving or declining them', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback }) => {
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Requires desktop approval', { sessionId: APP_ID }, writer, context);
    assert.ok(messages.some((message) => message.kind === 'task_notification' && /Answer it in Codex app/.test(message.summary)));
    assert.ok(!requests.some((request) => request.id === 'desktop-approval'));
  }, (request, socket) => {
    if (request.method !== 'turn/start') return false;
    reply(socket, request, { turn: { id: 'turn-new', status: 'inProgress' } });
    socket.send(JSON.stringify({
      id: 'desktop-approval', method: 'item/commandExecution/requestApproval',
      params: { threadId: THREAD_ID, turnId: 'turn-new' },
    }));
    // Simulate the desktop user handling their request.
    event(socket, 'turn/completed', { turn: { id: 'turn-new', status: 'completed' } });
    return true;
  });
});

test('the legacy fork adapter refuses native paginated history before spawning another app-server', { concurrency: false }, async () => {
  await withFixture(async ({ home, requests }) => {
    const db = new Database(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    db.close();
    await assert.rejects(codexAppServer.forkThread({ threadId: THREAD_ID, cwd: '/workspace/demo' }), /Fork or edit.*in Codex app/);
    assert.deepEqual(requests, []);
  });
});

test('daemon RPC timeouts fail once and do not leave pending requests', { concurrency: false }, async () => {
  await withFixture(async ({ requests }) => {
    const client = await CodexDaemonClient.connect({ timeoutMs: 200 });
    assert.ok(client);
    try {
      await assert.rejects(client.request('test/unanswered', {}), /not resubmitted/);
      assert.equal(requests.filter((request) => request.method === 'test/unanswered').length, 1);
    } finally {
      client.close();
    }
  }, (request) => request.method === 'test/unanswered');
});
