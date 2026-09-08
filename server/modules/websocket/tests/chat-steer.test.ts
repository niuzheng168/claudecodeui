import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import type { AnyRecord } from '@/shared/types.js';

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
    assert.deepEqual(calls, [['steer', 'codex', 'session-a', 'Focus on the tests', { images: [], files: [] }]]);
    for (const ws of [client, observer]) {
      assert.equal(ws.frames.filter((frame) => frame.role === 'user').length, 1);
      assert.equal(ws.frames[0].sessionId, 'session-a');
      assert.equal(ws.frames[0].seq, 1);
      assert.equal(ws.frames.some((frame) => frame.kind === 'complete'), false);
    }
    assert.equal(client.frames.at(-1)?.kind, 'chat_steer_result');
    assert.equal(client.frames.at(-1)?.accepted, true);
    assert.equal(observer.frames.some((frame) => frame.kind === 'chat_steer_result'), false);
    assert.equal(chatRunRegistry.replayEvents('session-a', 0)[0].content, 'Focus on the tests');
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
    assert.deepEqual(Object.keys(options), ['images', 'files']);
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
    runtime.canSteer = () => false;
    await send({ type: 'chat.subscribe', sessions: [{ sessionId: 'session-a' }] });
    assert.equal(client.frames.at(-1)?.canSteer, false);
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
