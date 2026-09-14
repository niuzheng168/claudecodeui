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
import type { AnyRecord, IProviderRuntime, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

const THREAD_ID = 'desktop-thread';
const DESKTOP_TURN_ID = 'desktop-active-turn';
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

function replyActiveDesktopThread(request: AnyRecord, socket: WebSocket): boolean {
  if (request.method === 'thread/goal/get') {
    reply(socket, request, { goal: null });
    return true;
  }
  if (request.method === 'thread/turns/list') {
    reply(socket, request, { data: [{
      id: DESKTOP_TURN_ID, status: 'inProgress', completedAt: null,
      items: [{ id: 'active-reply', type: 'agentMessage', text: 'Already ' }],
    }], nextCursor: 'older-turns' });
    return true;
  }
  if (request.method !== 'thread/resume' && request.method !== 'thread/read') return false;
  reply(socket, request, { thread: { id: THREAD_ID, status: { type: 'active' } } });
  return true;
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
      await writeFile(process.env.DATABASE_PATH, '');
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

test('an ordinary native turn preserves the browser input identity without changing its provider item id', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback }) => {
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('One input', {
      sessionId: APP_ID, clientMessageId: 'browser-input-one',
    }, writer, context);
    assert.equal(requests.find((request) => request.method === 'turn/start')?.params.clientUserMessageId,
      'browser-input-one');
    assert.equal(messages.at(-1)?.success, true);
  });
});

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
    assert.ok(!('sandboxPolicy' in starts[0].params));
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

test('new daemon sessions honor Codey permission choices on creation and the first turn', { concurrency: false }, async () => {
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
    assert.deepEqual(requests.filter((request) => request.method === 'turn/start').map((request) => ({
      approvalPolicy: request.params.approvalPolicy, sandboxPolicy: request.params.sandboxPolicy,
    })), [
      { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } },
      { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
    ]);
  });
});

test('existing daemon sessions apply selected permissions at turn start, not while attaching', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { writer, context } = executionContext();
    const runtime = new CodexSharedRuntime(fallback);
    for (const permissionMode of ['bypassPermissions', 'acceptEdits', 'default']) {
      await runtime.run('Apply my selected permissions', { sessionId: APP_ID, permissionMode }, writer, context);
    }
    assert.deepEqual(fallbackCalls, []);
    assert.ok(!requests.some((request) => request.method === 'thread/start' || request.method === 'thread/fork'));
    const resumes = requests.filter((request) => request.method === 'thread/resume');
    assert.equal(resumes.length, 3);
    for (const resumed of resumes) {
      assert.deepEqual(resumed.params, { threadId: THREAD_ID, excludeTurns: true });
    }
    assert.deepEqual(requests.filter((request) => request.method === 'turn/start').map((request) => ({
      threadId: request.params.threadId,
      approvalPolicy: request.params.approvalPolicy, sandboxPolicy: request.params.sandboxPolicy,
    })), [
      { threadId: THREAD_ID, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
      { threadId: THREAD_ID, approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } },
      { threadId: THREAD_ID, approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite' } },
    ]);
  });
});

test('full access is sent again when continuing the same Codey-created thread', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    sessionsDb.createAppSession(APP_ID, 'codex', '/workspace/demo', 'Full access session');
    context.resolveProviderSessionId = () => sessionsDb.getSessionById(APP_ID)?.provider_session_id ?? null;
    writer.setSessionId = (id) => sessionsDb.assignProviderSessionId(APP_ID, id);
    const runtime = new CodexSharedRuntime(fallback);
    const options = { sessionId: APP_ID, permissionMode: 'bypassPermissions', projectPath: '/workspace/demo' };
    await runtime.run('First prompt', options, writer, context);
    await runtime.run('Continue with full access', options, writer, context);
    assert.deepEqual(fallbackCalls, []);
    assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1);
    assert.equal(requests.filter((request) => request.method === 'thread/resume').length, 1);
    const turns = requests.filter((request) => request.method === 'turn/start');
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.equal(turn.params.threadId, THREAD_ID);
      assert.equal(turn.params.approvalPolicy, 'never');
      assert.deepEqual(turn.params.sandboxPolicy, { type: 'dangerFullAccess' });
    }
    assert.equal(messages.filter((message) => message.kind === 'complete' && message.success).length, 2);
  });
});

test('a rejected permission change is reported without retrying the turn or falling back to exec', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Use full access', {
      sessionId: APP_ID, permissionMode: 'bypassPermissions',
    }, writer, context);
    assert.deepEqual(fallbackCalls, []);
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.ok(!requests.some((request) => request.method === 'thread/start' || request.method === 'thread/fork'));
    assert.match(messages.find((message) => message.kind === 'error')?.content, /Full access is not allowed/);
    assert.equal(messages.at(-1)?.success, false);
  }, (request, socket) => {
    if (request.method !== 'turn/start') return false;
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Full access is not allowed by this daemon.' } }));
    return true;
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

test('an active desktop turn accepts same-turn input and buffers early output without taking ownership', { concurrency: false }, async () => {
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    const runtime = new CodexSharedRuntime(fallback);
    await runtime.run('Focus on the tests', {
      sessionId: APP_ID, model: 'different-model', effort: 'high',
      permissionMode: 'bypassPermissions', codexPlanMode: false,
    }, writer, context);
    assert.deepEqual(requests.filter((request) => request.method === 'turn/steer').map((request) => request.params), [{
      threadId: THREAD_ID, expectedTurnId: DESKTOP_TURN_ID,
      input: [{ type: 'text', text: 'Focus on the tests' }],
    }]);
    assert.ok(!requests.some((request) => [
      'turn/start', 'turn/interrupt', 'thread/start', 'thread/fork', 'thread/settings/update',
    ].includes(request.method)));
    assert.deepEqual(requests.find((request) => request.method === 'thread/resume')?.params, {
      threadId: THREAD_ID, excludeTurns: true,
    });
    assert.deepEqual(requests.find((request) => request.method === 'thread/read')?.params, {
      threadId: THREAD_ID, includeTurns: false,
    });
    assert.deepEqual(requests.find((request) => request.method === 'thread/turns/list')?.params, {
      threadId: THREAD_ID, limit: 1, sortDirection: 'desc', itemsView: 'full',
    });
    assert.deepEqual(fallbackCalls, []);
    assert.ok(messages.some((message) => message.id === 'active-reply' && message.content === 'Already continued.'));
    assert.ok(!messages.some((message) => message.content === 'DO NOT SHOW' || message.role === 'user'));
    assert.ok(messages.some((message) => message.kind === 'task_notification' && /stay unchanged/.test(message.summary)));
    assert.ok(messages.some((message) => message.kind === 'status' && message.canInterrupt === false));
    assert.ok(!messages.some((message) => message.canInterrupt === true || message.canSteer === true));
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.at(-1)?.success, true);
    assert.equal(runtime.canSteer(APP_ID), false);
  }, (request, socket) => {
    if (request.method !== 'turn/steer') return replyActiveDesktopThread(request, socket);
    event(socket, 'item/completed', {
      threadId: 'other-thread', turnId: DESKTOP_TURN_ID,
      item: { id: 'foreign-thread', type: 'agentMessage', text: 'DO NOT SHOW' },
    });
    event(socket, 'item/completed', { item: { id: 'foreign-turn', type: 'agentMessage', text: 'DO NOT SHOW' } });
    event(socket, 'item/completed', {
      turnId: null, item: { id: 'unverified-turn', type: 'agentMessage', text: 'DO NOT SHOW' },
    });
    event(socket, 'turn/completed', { turn: { id: 'turn-new', status: 'failed' } });
    event(socket, 'item/completed', {
      turnId: DESKTOP_TURN_ID,
      item: { id: 'native-user-echo', type: 'userMessage', content: [{ type: 'text', text: 'Focus on the tests' }] },
    });
    event(socket, 'item/agentMessage/delta', { turnId: DESKTOP_TURN_ID, itemId: 'active-reply', delta: 'continued.' });
    event(socket, 'turn/completed', { turnId: DESKTOP_TURN_ID, turn: { id: DESKTOP_TURN_ID, status: 'completed' } });
    reply(socket, request, { turnId: DESKTOP_TURN_ID });
    return true;
  });
});

test('an attached desktop turn remains steerable but cannot be stopped or auto-approved by Codey', { concurrency: false }, async () => {
  let ready!: () => void;
  const accepted = new Promise<void>((resolve) => { ready = resolve; });
  let steers = 0;
  await withFixture(async ({ requests, fallback, fallbackCalls }) => {
    const { messages, writer, context } = executionContext();
    const originalSend = writer.send;
    writer.send = (message) => {
      originalSend(message);
      if ((message as AnyRecord).canSteer === true) ready();
    };
    const runtime = new CodexSharedRuntime(fallback);
    const running = runtime.run('First correction', { sessionId: APP_ID }, writer, context);
    await accepted;
    assert.equal(runtime.canSteer(APP_ID), true);
    assert.ok(messages.some((message) => message.canSteer === true && message.canInterrupt === false));
    await assert.rejects(runtime.abort(APP_ID), { code: 'CODEX_DESKTOP_TURN_NOT_OWNED' });
    assert.equal(runtime.canSteer(APP_ID), true);
    assert.ok(!messages.some((message) => message.kind === 'complete'));
    await runtime.steer(APP_ID, 'Also check the edge cases', {
      threadId: 'wrong-thread', expectedTurnId: 'wrong-turn', permissionMode: 'bypassPermissions',
    });
    await running;
    assert.deepEqual(fallbackCalls, []);
    assert.equal(requests.filter((request) => request.method === 'turn/steer').length, 2);
    assert.ok(requests.filter((request) => request.method === 'turn/steer')
      .every((request) => request.params.expectedTurnId === DESKTOP_TURN_ID && request.params.threadId === THREAD_ID));
    assert.ok(!requests.some((request) => request.method === 'turn/interrupt' || request.method === 'turn/start'));
    assert.ok(!requests.some((request) => request.id === 'desktop-approval'));
    assert.ok(messages.some((message) => message.kind === 'task_notification' && /Answer it in Codex app/.test(message.summary)));
    assert.ok(messages.some((message) => message.content === 'Corrected output'));
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    await assert.rejects(runtime.steer(APP_ID, 'Too late', {}), { code: 'STEER_UNAVAILABLE' });
  }, (request, socket) => {
    if (request.method !== 'turn/steer') return replyActiveDesktopThread(request, socket);
    reply(socket, request, { turnId: DESKTOP_TURN_ID });
    if (++steers === 1) {
      socket.send(JSON.stringify({
        id: 'desktop-approval', method: 'item/commandExecution/requestApproval',
        params: { threadId: THREAD_ID, turnId: DESKTOP_TURN_ID },
      }));
    } else {
      event(socket, 'item/completed', {
        turnId: DESKTOP_TURN_ID, item: { id: 'active-reply', type: 'agentMessage', text: 'Corrected output' },
      });
      event(socket, 'turn/completed', { turnId: DESKTOP_TURN_ID, turn: { id: DESKTOP_TURN_ID, status: 'completed' } });
    }
    return true;
  });
});

test('the initial desktop correction preserves images and file references in native input', { concurrency: false }, async () => {
  await withFixture(async ({ root, requests, fallback }) => {
    const { writer, context } = executionContext();
    await new CodexSharedRuntime(fallback).run('Use these requirements', {
      sessionId: APP_ID, cwd: root,
      images: [{ path: 'screen.png' }],
      files: [{ path: path.join(root, 'requirements.txt'), name: 'requirements.txt' }],
    }, writer, context);
    const input = requests.find((request) => request.method === 'turn/steer')?.params.input;
    assert.match(input[0].text, /Use these requirements[\s\S]*<files_input>/);
    assert.ok(input[0].text.includes(path.join(root, 'requirements.txt')));
    assert.deepEqual(input[1], { type: 'localImage', path: path.join(root, 'screen.png') });
  }, (request, socket) => {
    if (request.method !== 'turn/steer') return replyActiveDesktopThread(request, socket);
    reply(socket, request, { turnId: DESKTOP_TURN_ID });
    event(socket, 'turn/completed', { turnId: DESKTOP_TURN_ID, turn: { id: DESKTOP_TURN_ID, status: 'completed' } });
    return true;
  });
});

for (const [name, thread] of Object.entries({
  'missing active turn': { id: THREAD_ID, status: { type: 'active' }, turns: history },
  'another thread': { id: 'foreign', status: { type: 'active' }, turns: [{ id: DESKTOP_TURN_ID, status: 'inProgress' }] },
  'a turn that finished during attach': { id: THREAD_ID, status: { type: 'idle' }, turns: [{ id: DESKTOP_TURN_ID, status: 'completed' }] },
  'multiple active turns': { id: THREAD_ID, status: { type: 'active' }, turns: [
    { id: 'first', status: 'inProgress' }, { id: 'second', status: 'inProgress' },
  ] },
  'an empty turn id': { id: THREAD_ID, status: { type: 'active' }, turns: [{ id: '', status: 'inProgress' }] },
  'a durably ended turn': { id: THREAD_ID, status: { type: 'active' }, turns: [{ id: DESKTOP_TURN_ID, status: 'inProgress', completedAt: CREATED_AT }] },
})) {
  test(`desktop steering fails closed for ${name}`, { concurrency: false }, async () => {
    await withFixture(async ({ requests, fallback, fallbackCalls }) => {
      const { messages, writer, context } = executionContext();
      await new CodexSharedRuntime(fallback).run('Do not guess the turn', { sessionId: APP_ID }, writer, context);
      assert.deepEqual(fallbackCalls, []);
      assert.ok(!requests.some((request) => ['turn/steer', 'turn/start', 'turn/interrupt', 'thread/fork'].includes(request.method)));
      assert.match(messages.find((message) => message.kind === 'error')?.content, /active Codex turn.*No message was submitted/);
      assert.equal(messages.at(-1)?.success, false);
    }, (request, socket) => {
      if (request.method === 'thread/turns/list') {
        reply(socket, request, { data: thread.turns });
        return true;
      }
      if (request.method !== 'thread/read') return replyActiveDesktopThread(request, socket);
      reply(socket, request, { thread });
      return true;
    });
  });
}

for (const failure of ['stale turn', 'wrong acknowledgement', 'missing acknowledgement', 'disconnect', 'timeout']) {
  test(`desktop steering never retries after ${failure}`, { concurrency: false }, async () => {
    await withFixture(async ({ requests, fallback, fallbackCalls }) => {
      const { messages, writer, context } = executionContext();
      const runtime = new CodexSharedRuntime(fallback, () => CodexDaemonClient.connect({ timeoutMs: 200 }));
      await runtime.run('Submit only once', { sessionId: APP_ID }, writer, context);
      assert.equal(requests.filter((request) => request.method === 'turn/steer').length, 1);
      assert.ok(!requests.some((request) => [
        'turn/start', 'turn/interrupt', 'thread/start', 'thread/fork', 'thread/queue/add',
      ].includes(request.method)));
      assert.deepEqual(fallbackCalls, []);
      assert.ok(messages.some((message) => message.kind === 'error'));
      assert.equal(messages.at(-1)?.success, false);
      assert.equal(runtime.canSteer(APP_ID), false);
    }, (request, socket) => {
      if (request.method !== 'turn/steer') return replyActiveDesktopThread(request, socket);
      if (failure === 'stale turn') {
        socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'expectedTurnId does not match the active turn' } }));
      } else if (failure === 'wrong acknowledgement') {
        reply(socket, request, { turnId: 'newer-desktop-turn' });
      } else if (failure === 'missing acknowledgement') {
        reply(socket, request, {});
      } else if (failure === 'disconnect') {
        reply(socket, request, { turnId: DESKTOP_TURN_ID });
        socket.close();
      }
      return true; // timeout deliberately has no acknowledgement.
    });
  });
}

for (const command of ['/goal Finish the project', '/plan Plan a migration']) {
  test(`a busy desktop turn does not treat ${command.split(' ')[0]} as a correction`, { concurrency: false }, async () => {
    await withFixture(async ({ requests, fallback }) => {
      const { messages, writer, context } = executionContext();
      await new CodexSharedRuntime(fallback).run(command, { sessionId: APP_ID }, writer, context);
      assert.ok(!requests.some((request) => [
        'turn/steer', 'turn/start', 'turn/interrupt', 'thread/settings/update', 'thread/goal/set',
      ].includes(request.method)));
      assert.match(messages.find((message) => message.kind === 'error')?.content, /require an idle session/);
      assert.equal(messages.at(-1)?.success, false);
    }, replyActiveDesktopThread);
  });
}

test('cancelling while attach is pending never submits to or interrupts the desktop turn', { concurrency: false }, async () => {
  let resume!: () => void;
  let ready!: () => void;
  const pendingResume = new Promise<void>((resolve) => { ready = resolve; });
  await withFixture(async ({ requests, fallback }) => {
    const { writer, context } = executionContext();
    const runtime = new CodexSharedRuntime(fallback);
    const running = runtime.run('Cancelled before attach', { sessionId: APP_ID }, writer, context);
    await pendingResume;
    assert.equal(await runtime.abort(APP_ID), true);
    resume();
    await running;
    assert.ok(!requests.some((request) => ['turn/steer', 'turn/start', 'turn/interrupt'].includes(request.method)));
  }, (request, socket) => {
    if (request.method !== 'thread/resume') return false;
    resume = () => { replyActiveDesktopThread(request, socket); };
    ready();
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

test('non-Windows partial paginated JSONL is never presented as complete history when the daemon is absent', { concurrency: false }, async () => {
  await withFixture(async ({ home }) => {
    const db = new Database(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    db.close();
    const partial = path.join(home, 'partial.jsonl');
    await writeFile(partial, JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID, cwd: '/workspace/demo' } }) + '\n');
    sessionsDb.createSession(THREAD_ID, 'codex', '/workspace/demo', 'Native session', undefined, undefined, partial);
    await assert.rejects(new CodexSessionsProvider('linux').fetchHistory(THREAD_ID), /Connect its local daemon/);
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
    await new CodexSharedRuntime(fallback).run('Requires desktop approval', {
      sessionId: APP_ID, permissionMode: 'bypassPermissions',
    }, writer, context);
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
