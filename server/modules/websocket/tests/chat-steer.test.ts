import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';

import { sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, steerQueuedChatMessage } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import type { AnyRecord } from '@/shared/types.js';
import { AppError } from '@/shared/index.js';
import type { ProviderAbortOptions, ProviderRuntimeObservation, QueuedSessionMessageRecord } from '@/shared/index.js';

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    frames: [] as AnyRecord[],
    send(data: string) { this.frames.push(JSON.parse(data)); },
  });
}

async function fixture(t: TestContext, body: (f: {
  client: ReturnType<typeof socket>;
  observer: ReturnType<typeof socket>;
  calls: unknown[][];
  run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;
  send: (overrides?: AnyRecord) => Promise<void>;
  runtime: {
    abort: (provider: string, sessionId: string, options?: ProviderAbortOptions) => Promise<boolean>;
    canInterrupt?: () => boolean;
    prepareObservation?: (provider: string, sessionId: string) => Promise<ProviderRuntimeObservation | null>;
    canSteer: () => boolean;
    steer: (provider: string, sessionId: string, command: string, options: AnyRecord) => Promise<void>;
  };
}) => Promise<void>) {
  t.mock.method(sessionsDb, 'getSessionById', (id: string) => id === 'session-a'
    ? { id, provider: 'codex', provider_session_id: 'native-a', project_path: process.cwd() }
    : null);
  chatRunRegistry.clearAll();
  const client = socket();
  const observer = socket();
  const calls: unknown[][] = [];
  const runtime = {
    hasRuntime: () => true,
    run: async () => { calls.push(['run']); },
    abort: async () => { calls.push(['abort']); return true; },
    canSteer: () => true,
    steer: async (...args: [string, string, string, AnyRecord]) => { calls.push(['steer', ...args]); },
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  };
  const run = chatRunRegistry.startRun({
    appSessionId: 'session-a', provider: 'codex', providerSessionId: 'native-a',
    connection: observer, userId: 1,
  })!;
  handleChatConnection(client as never, { user: { id: 1 } } as never, { runtime });
  try {
    await body({
      client, observer, calls, run, runtime,
      send: async (overrides = {}) => {
        client.emit('message', JSON.stringify({
          type: 'chat.steer', sessionId: 'session-a', requestId: 'request-a',
          expectedRunId: run.id,
          content: 'Focus on the tests', ...overrides,
        }));
        await nextTick();
      },
    });
  } finally {
    chatRunRegistry.clearAll();
    connectedClients.clear();
  }
}

test('accepted corrections use the same run and are echoed once to all subscribers', async (t) => {
  await fixture(t, async ({ send, client, observer, run, calls }) => {
    await send();
    assert.equal(chatRunRegistry.getRun('session-a'), run);
    assert.equal(run.status, 'running');
    const clientMessageId = (calls[0][4] as AnyRecord).clientMessageId;
    assert.match(clientMessageId, /^codey_user_[a-f0-9-]{36}$/);
    assert.deepEqual(calls, [['steer', 'codex', 'session-a', 'Focus on the tests', { images: [], files: [], clientMessageId }]]);
    for (const ws of [client, observer]) {
      assert.equal(ws.frames.filter((frame) => frame.role === 'user').length, 1);
      assert.equal(ws.frames[0].sessionId, 'session-a');
      assert.equal(ws.frames[0].seq, 1);
      assert.equal(ws.frames[0].clientMessageId, clientMessageId);
      assert.equal(ws.frames.some((frame) => frame.kind === 'complete'), false);
    }
    assert.equal(client.frames.at(-1)?.kind, 'chat_steer_result');
    assert.equal(client.frames.at(-1)?.accepted, true);
    assert.equal(observer.frames.some((frame) => frame.kind === 'chat_steer_result'), false);
    assert.equal(chatRunRegistry.replayEvents('session-a', 0)[0].content, 'Focus on the tests');
  });
});

test('a late goal Stop acknowledgement cannot complete the next queued run', async (t) => {
  await fixture(t, async ({ runtime, run, observer, send }) => {
    let successor: ReturnType<typeof chatRunRegistry.startRun> | undefined;
    t.mock.method(runtime, 'abort', async () => {
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
      successor = chatRunRegistry.startRun({
        appSessionId: 'session-a', provider: 'codex', providerSessionId: 'native-a',
        connection: observer, userId: 1,
      });
      await nextTick();
      return true;
    });
    await send({ type: 'chat.abort' });
    assert.ok(successor);
    assert.equal(chatRunRegistry.getRun('session-a'), successor);
    assert.equal(successor.status, 'running');
  });
});

test('only an explicit Stop bound to the current user/run can interrupt a desktop observation', async (t) => {
  await fixture(t, async ({ runtime, run, client, calls, send }) => {
    runtime.abort = async (...args) => { calls.push(['abort', ...args]); return true; };
    await send({ type: 'chat.abort', expectedRunId: 'older-run' });
    assert.equal(client.frames.at(-1)?.code, 'ABORT_STALE_RUN');
    assert.equal(run.status, 'running');
    run.writer.userId = 2;
    await send({ type: 'chat.abort' });
    assert.equal(client.frames.at(-1)?.code, 'ABORT_FORBIDDEN');
    assert.equal(calls.length, 0);
    run.writer.userId = 1;
    await send({ type: 'chat.abort' });
    assert.deepEqual(calls, [['abort', 'codex', 'session-a', { allowExternalTurn: true }]]);
    assert.equal(run.status, 'completed');
  });
});

test('a refused or unconfirmed Stop does not complete the run or release its queue', async (t) => {
  await fixture(t, async ({ runtime, run, client, observer, send }) => {
    runtime.abort = async () => { throw new Error('Native interrupt acknowledgement was lost'); };
    await send({ type: 'chat.abort' });
    assert.equal(client.frames.at(-1)?.kind, 'chat_abort_result');
    assert.equal(client.frames.at(-1)?.accepted, false);
    assert.equal(run.status, 'running');
    assert.equal(observer.frames.length, 0);
    runtime.abort = async () => false;
    await send({ type: 'chat.abort' });
    assert.equal(client.frames.at(-1)?.code, 'ABORT_UNCONFIRMED');
    assert.equal(run.status, 'running');
    assert.equal(observer.frames.length, 0);
  });
});

test('an older Stop request without a run receipt never grants desktop interruption', async (t) => {
  await fixture(t, async ({ runtime, calls, send }) => {
    runtime.abort = async (...args) => { calls.push(['abort', ...args]); return true; };
    await send({ type: 'chat.abort', expectedRunId: undefined });
    assert.deepEqual(calls, [['abort', 'codex', 'session-a', { allowExternalTurn: false }]]);
  });
});

test('opening a desktop session registers observation and enables queue promotion before the first send', async (t) => {
  await fixture(t, async ({ runtime, client, calls, send }) => {
    chatRunRegistry.clearAll();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    runtime.prepareObservation = async (provider, sessionId) => {
      calls.push(['prepare', provider, sessionId]);
      return {
        start: async (writer) => {
          calls.push(['observe']);
          writer.send({ kind: 'status', provider: 'codex', sessionId: 'native-a', canSteer: true, canInterrupt: true });
          await finished;
          writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-a', exitCode: 0 });
        },
        dispose: () => { calls.push(['dispose']); },
      };
    };
    runtime.canInterrupt = () => true;
    await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a' }] });
    const run = chatRunRegistry.getRun('session-a');
    assert.ok(run);
    assert.equal(run.status, 'running');
    assert.deepEqual(calls, [['prepare', 'codex', 'session-a'], ['observe']]);
    assert.equal(client.frames[0].kind, 'chat_subscribed');
    assert.equal(client.frames[0].isProcessing, true);
    assert.equal(client.frames[0].canSteerQueued, true);
    assert.equal(client.frames[0].canInterrupt, true);
    assert.equal(client.frames[0].runId, run.id);
    await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a', lastSeq: run.lastSeq }] });
    assert.equal(calls.filter(([method]) => method === 'prepare').length, 1);
    await send({ expectedRunId: run.id });
    assert.equal(calls.filter(([method]) => method === 'steer').length, 1);
    assert.equal(calls.filter(([method]) => method === 'run' || method === 'abort').length, 0);
    finish();
    await nextTick();
    assert.equal(run.status, 'completed');
  });
});

test('an idle native probe leaves the session available without a phantom run or completion', async (t) => {
  await fixture(t, async ({ runtime, client, send }) => {
    chatRunRegistry.clearAll();
    runtime.prepareObservation = async () => null;
    await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a' }] });
    assert.equal(chatRunRegistry.getRun('session-a'), undefined);
    assert.equal(client.frames.length, 1);
    assert.equal(client.frames[0].isProcessing, false);
    assert.equal(client.frames[0].canInterrupt, false);
  });
});

test('a concurrent send wins observation admission without losing its run or leaking the prepared connection', async (t) => {
  await fixture(t, async ({ runtime, observer, calls, send }) => {
    chatRunRegistry.clearAll();
    let prepared!: (observation: ProviderRuntimeObservation) => void;
    runtime.prepareObservation = () => new Promise((resolve) => { prepared = resolve; });
    await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a' }] });
    const sent = chatRunRegistry.startRun({
      appSessionId: 'session-a', provider: 'codex', providerSessionId: 'native-a',
      connection: observer, userId: 1,
    });
    prepared({
      start: async () => { calls.push(['observe']); },
      dispose: () => { calls.push(['dispose']); },
    });
    await nextTick();
    assert.deepEqual(calls, [['dispose']]);
    assert.equal(chatRunRegistry.getRun('session-a'), sent);
    assert.equal(sent?.status, 'running');
  });
});

test('only upload-store attachments reach steering; execution settings are ignored', async (t) => {
  await fixture(t, async ({ send, calls }) => {
    const image = { path: path.join(getGlobalImageAssetsDir(), 'correction.png'), name: 'correction.png' };
    const file = { path: path.join(getGlobalImageAssetsDir(), 'notes.txt'), name: 'notes.txt' };
    await send({
      options: {
        attachments: [image, file, image, { path: path.resolve('secrets.txt') }],
        images: [{ path: path.resolve('secret.png') }],
        model: 'changed', permissionMode: 'bypassPermissions', cwd: '/untrusted', threadId: 'other',
      },
    });
    const options = calls[0][4] as AnyRecord;
    assert.deepEqual(Object.keys(options), ['images', 'files', 'clientMessageId']);
    assert.deepEqual(options.images.map((value: AnyRecord) => value.path), [image.path]);
    assert.deepEqual(options.files.map((value: AnyRecord) => value.path), [file.path]);
  });
});

test('a rejected correction is not echoed, queued, restarted or marked complete', async (t) => {
  await fixture(t, async ({ send, client, observer, run, runtime }) => {
    runtime.steer = async () => { throw new Error('expectedTurnId mismatch'); };
    await send();
    assert.equal(run.status, 'running');
    assert.equal(client.frames.length, 1);
    assert.equal(client.frames[0].kind, 'chat_steer_result');
    assert.equal(client.frames[0].accepted, false);
    assert.match(client.frames[0].error, /expectedTurnId/);
    assert.equal(observer.frames.length, 0);
  });
});

test('idle, unsupported, malformed and cross-user requests are refused without affecting the run', async (t) => {
  await fixture(t, async ({ send, client, calls, runtime, run }) => {
    await send({ sessionId: 'missing' });
    assert.equal(client.frames.at(-1)?.code, 'NO_ACTIVE_RUN');
    await send({ content: '', options: { attachments: [{ path: path.resolve('outside.png') }] } });
    assert.equal(client.frames.at(-1)?.code, 'STEER_EMPTY');
    await send({ requestId: '' });
    assert.equal(client.frames.at(-1)?.code, 'INVALID_STEER_REQUEST');
    await send({ expectedRunId: 'old-run' });
    assert.equal(client.frames.at(-1)?.code, 'STEER_STALE_RUN');
    runtime.canSteer = () => false;
    await send();
    assert.equal(client.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    runtime.canSteer = () => true;
    run.writer.userId = 2;
    await send();
    assert.equal(client.frames.at(-1)?.code, 'STEER_FORBIDDEN');
    assert.equal(calls.length, 0);
    assert.equal(run.status, 'running');
  });
});

test('a late acknowledgement cannot complete or replace a newer run', async (t) => {
  await fixture(t, async ({ send, client, observer, runtime }) => {
    let accept!: () => void;
    runtime.steer = () => new Promise<void>((resolve) => { accept = resolve; });
    await send();
    chatRunRegistry.completeRun('session-a', { exitCode: 0 });
    const newerRun = chatRunRegistry.startRun({
      appSessionId: 'session-a', provider: 'codex', providerSessionId: 'native-a',
      connection: observer, userId: 1,
    });
    accept();
    await nextTick();
    assert.equal(chatRunRegistry.getRun('session-a'), newerRun);
    assert.equal(newerRun?.status, 'running');
    assert.equal(newerRun?.lastSeq, 0);
    assert.equal(client.frames.at(-1)?.accepted, true);
  });
});

test('reconnecting clients receive native steering capability only for supported runs', async (t) => {
  await fixture(t, async ({ client, send, runtime }) => {
    await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a' }] });
    assert.equal(client.frames.at(-1)?.canSteer, true);
    assert.equal(client.frames.at(-1)?.canSteerQueued, true);
    runtime.canInterrupt = () => false;
    runtime.canSteer = () => false;
    await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a' }] });
    assert.equal(client.frames.at(-1)?.canSteer, false);
    assert.equal(client.frames.at(-1)?.canSteerQueued, false);
    assert.equal(client.frames.at(-1)?.canInterrupt, false);
  });
});

test('live capability events advertise queued promotion on this backend without changing the run token', async (t) => {
  await fixture(t, async ({ run, observer }) => {
    run.writer.send({ kind: 'status', provider: 'codex', sessionId: 'native-a', canSteer: true });
    assert.equal(observer.frames.at(-1)?.canSteerQueued, true);
    assert.equal(observer.frames.at(-1)?.runId, run.id);
    run.writer.send({ kind: 'status', provider: 'codex', sessionId: 'native-a', canSteer: false });
    assert.equal(observer.frames.at(-1)?.canSteerQueued, false);
  });
});

function queuedStore(t: TestContext, message: AnyRecord = { id: 'queue-a', content: 'Queued instructions' }) {
  let stored: QueuedSessionMessageRecord | null = {
    userId: 1, sessionId: 'session-a', queuedMessage: message, claimToken: JSON.stringify(message),
  };
  t.mock.method(sessionDraftsDb, 'getQueuedMessage', (userId: number, sessionId: string) =>
    stored?.userId === userId && stored?.sessionId === sessionId ? stored : null);
  const claim = t.mock.method(sessionDraftsDb, 'claimQueuedMessage', (candidate: QueuedSessionMessageRecord) => {
    if (!stored || stored.claimToken !== candidate.claimToken) return false;
    stored = null;
    return true;
  });
  const restore = t.mock.method(sessionDraftsDb, 'restoreQueuedMessage', (candidate: QueuedSessionMessageRecord) => {
    if (stored) return false;
    stored = { ...candidate, queuedMessage: JSON.parse(candidate.claimToken) };
    return true;
  });
  t.mock.method(sessionDraftsDb, 'deleteEmptyDraft', () => {});
  return {
    message, claim, restore, read: () => stored,
    replace: (next: AnyRecord) => {
      stored = { userId: 1, sessionId: 'session-a', queuedMessage: next, claimToken: JSON.stringify(next) };
    },
  };
}

test('HTTP promotion claims the queued receipt before awaiting native acceptance, blocking a duplicate request', async (t) => {
  await fixture(t, async ({ runtime, run, observer, calls }) => {
    const queue = queuedStore(t);
    let accept!: () => void;
    runtime.steer = (...args) => {
      calls.push(['steer', ...args]);
      return new Promise<void>((resolve) => { accept = resolve; });
    };
    const request = {
      sessionId: 'session-a', requestId: 'r', expectedRunId: run.id, queuedMessage: queue.message,
      content: 'Do not send this textarea draft', options: { model: 'not-the-model' },
    };
    const pending = steerQueuedChatMessage(1, request, { runtime: runtime as never });
    assert.equal(queue.read(), null);
    assert.equal(queue.claim.mock.callCount(), 1);
    assert.equal((await steerQueuedChatMessage(1, request, { runtime: runtime as never })).code, 'STEER_QUEUE_CHANGED');
    const clientMessageId = (calls[0][4] as AnyRecord).clientMessageId;
    assert.match(clientMessageId, /^codey_user_[a-f0-9-]{36}$/);
    assert.deepEqual(calls, [['steer', 'codex', 'session-a', 'Queued instructions', { images: [], files: [], clientMessageId }]]);
    accept();
    assert.equal((await pending).accepted, true);
    assert.equal(queue.restore.mock.callCount(), 0);
    assert.equal(observer.frames.filter((frame) => frame.role === 'user').length, 1);
    assert.equal(run.status, 'running');
  });
});

test('queued steering validates owner, run and exact queue without claiming stale input', async (t) => {
  await fixture(t, async ({ runtime, run, calls }) => {
    const queue = queuedStore(t);
    const request = { sessionId: 'session-a', requestId: 'r', expectedRunId: run.id, queuedMessage: queue.message };
    for (const [userId, overrides, code] of [
      [2, {}, 'STEER_FORBIDDEN'],
      [1, { expectedRunId: 'old' }, 'STEER_STALE_RUN'],
      [1, { queuedMessage: { ...queue.message, id: 'other' } }, 'STEER_QUEUE_CHANGED'],
      [1, { queuedMessage: { ...queue.message, content: 'different' } }, 'STEER_QUEUE_CHANGED'],
      [1, { queuedMessage: undefined }, 'INVALID_STEER_REQUEST'],
    ] as const) {
      assert.equal((await steerQueuedChatMessage(userId, { ...request, ...overrides }, { runtime: runtime as never })).code, code);
    }
    assert.equal(calls.length, 0);
    assert.equal(queue.claim.mock.callCount(), 0);
    assert.deepEqual(queue.read()?.queuedMessage, queue.message);
  });
});

test('a definite native refusal restores the original queued message without a fallback run', async (t) => {
  await fixture(t, async ({ runtime, run, observer }) => {
    const queue = queuedStore(t);
    runtime.steer = async () => { throw new AppError('Turn no longer accepts input', { code: 'CODEX_DAEMON_RPC_ERROR' }); };
    const result = await steerQueuedChatMessage(1, {
      sessionId: 'session-a', requestId: 'r', expectedRunId: run.id, queuedMessage: queue.message,
    }, { runtime: runtime as never });
    assert.equal(result.accepted, false);
    assert.equal(result.queueRestored, true);
    assert.equal(result.queueHeld, false);
    assert.deepEqual(queue.read()?.queuedMessage, queue.message);
    assert.equal(observer.frames.length, 0);
    assert.equal(run.status, 'running');
  });
});

test('ambiguous native failure restores a held queue that cannot immediately be retried', async (t) => {
  await fixture(t, async ({ runtime, run, observer }) => {
    const queue = queuedStore(t);
    let attempts = 0;
    runtime.steer = async () => { attempts++; throw new Error('Daemon disconnected before acknowledgement'); };
    const request = { sessionId: 'session-a', requestId: 'r', expectedRunId: run.id, queuedMessage: queue.message };
    const result = await steerQueuedChatMessage(1, request, { runtime: runtime as never });
    assert.equal(result.queueRestored, true);
    assert.equal(result.queueHeld, true);
    const held = { ...queue.message, steerHold: 'unconfirmed' };
    assert.deepEqual(queue.read()?.queuedMessage, held);
    assert.equal((await steerQueuedChatMessage(1, { ...request, queuedMessage: held }, { runtime: runtime as never })).code, 'STEER_REVIEW_REQUIRED');
    assert.equal(attempts, 1);
    assert.equal(observer.frames.length, 0);
  });
});

test('a late native refusal cannot overwrite a queue created on another device', async (t) => {
  await fixture(t, async ({ runtime, run }) => {
    const queue = queuedStore(t);
    let refuse!: (error: Error) => void;
    runtime.steer = () => new Promise<void>((_resolve, reject) => { refuse = reject; });
    const pending = steerQueuedChatMessage(1, {
      sessionId: 'session-a', requestId: 'r', expectedRunId: run.id, queuedMessage: queue.message,
    }, { runtime: runtime as never });
    const next = { id: 'new', content: 'From another device' };
    queue.replace(next);
    refuse(new AppError('Refused', { code: 'STEER_UNAVAILABLE' }));
    assert.equal((await pending).queueRestored, false);
    assert.deepEqual(queue.read()?.queuedMessage, next);
  });
});

test('queued acceptance stays accepted when empty-row housekeeping fails', async (t) => {
  await fixture(t, async ({ runtime, run, calls }) => {
    const file = { path: path.join(getGlobalImageAssetsDir(), 'notes.txt'), name: 'notes.txt' };
    const queue = queuedStore(t, { id: 'q', content: '', attachments: [file], options: { model: 'ignore', permissionMode: 'ignore' } });
    t.mock.method(sessionDraftsDb, 'deleteEmptyDraft', () => { throw new Error('Disk busy'); });
    const result = await steerQueuedChatMessage(1, {
      sessionId: 'session-a', requestId: 'r', expectedRunId: run.id, queuedMessage: queue.message,
    }, { runtime: runtime as never });
    assert.equal(result.accepted, true);
    assert.equal(queue.read(), null);
    assert.equal(queue.restore.mock.callCount(), 0);
    assert.deepEqual((calls[0][4] as AnyRecord).images, []);
    assert.equal((calls[0][4] as AnyRecord).files[0].path, file.path);
    assert.deepEqual(Object.keys(calls[0][4] as AnyRecord), ['images', 'files', 'clientMessageId']);
  });
});

test('a broken observer cannot turn an accepted native correction into a refusal', async (t) => {
  await fixture(t, async ({ send, client, observer, calls, run }) => {
    observer.send = () => { throw new Error('Observer disconnected during send'); };
    await send();
    assert.equal(client.frames.at(-1)?.accepted, true);
    assert.equal(calls.filter(([method]) => method === 'steer').length, 1);
    assert.equal(run.status, 'running');
  });
});
