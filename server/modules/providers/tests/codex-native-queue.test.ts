import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexNativeQueueRun } from '@/modules/providers/list/codex/codex-native-queue.service.js';
import type { AnyRecord, ICodexDesktopThreadOwner, ICodexRpcClient } from '@/shared/index.js';

function fixture(options: { pending?: boolean; lostAck?: boolean; wrongThread?: boolean; loaded?: boolean; sharedDaemon?: boolean; incompleteItems?: boolean; transientInterrupted?: boolean; clientMessageId?: string; deleteAck?: boolean | null } = {}) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const items: AnyRecord[] = [];
  const started: string[] = [];
  let clientId = '';
  let created = false;
  let deleted = false;
  let completed = !options.transientInterrupted;
  let pending = options.pending;
  let sleeping: (() => void) | null = null;
  let sleepEntered!: () => void;
  const asleep = new Promise<void>(resolve => { sleepEntered = resolve; });
  const client: ICodexRpcClient = {
    ownsProcess: !options.sharedDaemon,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: options.wrongThread ? 'somebody-else' : 'desktop', source: 'vscode' } };
      if (method === 'thread/loaded/list') return { data: options.loaded ? ['desktop'] : options.sharedDaemon ? ['unrelated-thread'] : [] };
      if (method === 'thread/queue/add') {
        created = true;
        clientId = params.clientUserMessageId;
        if (options.lostAck) throw new Error('transport timeout after submission');
        return { queuedSubmission: { id: 'our-queue', clientUserMessageId: clientId } };
      }
      if (method === 'thread/queue/list') return {
        data: [
          { id: 'another-queue', clientUserMessageId: 'another-client' },
          ...(created && !deleted && pending ? [{ id: 'our-queue', clientUserMessageId: clientId }] : []),
        ], nextCursor: null,
      };
      if (method === 'thread/queue/delete') {
        assert.equal(params.queuedSubmissionId, 'our-queue');
        const acknowledged = options.deleteAck === undefined || options.deleteAck === true;
        if (acknowledged) deleted = true;
        return options.deleteAck === null ? {} : { deleted: acknowledged };
      }
      if (method === 'thread/turns/list') return {
        data: [
          ...(created && !pending ? [
            { id: 'foreign-turn', status: 'completed', items: [{ type: 'userMessage', id: 'other-user', clientId: 'another-client' }] },
            {
              id: 'our-turn', status: completed ? 'completed' : 'interrupted',
              completedAt: completed ? 1788933273 : null, itemsView: options.incompleteItems ? 'summary' : 'full',
              items: [{ type: 'userMessage', id: 'our-user', clientId },
                ...(completed ? [{ type: 'agentMessage', id: 'answer', text: 'DESKTOP_REPLY' }] : [])],
            },
          ] : []),
          { id: 'baseline', status: 'completed', items: [] },
        ], nextCursor: null,
      };
      assert.fail(`Unexpected RPC: ${method}`);
    },
    onNotification: () => () => {}, onServerRequest: () => () => {},
    onDisconnect: () => () => {}, close: () => {},
  };
  const run = new CodexNativeQueueRun(client, 'desktop', {
    item: item => items.push(item), started: id => started.push(id),
  }, { clientMessageId: options.clientMessageId, sleep: async () => {
    sleepEntered();
    await new Promise<void>(resolve => { sleeping = resolve; });
  } });
  return {
    run, calls, items, started, asleep, wake: () => { completed = true; sleeping?.(); },
    claim: () => { pending = false; completed = true; sleeping?.(); },
  };
}

test('desktop queue preserves the browser input identity through its native receipt', async () => {
  const f = fixture({ clientMessageId: 'browser-input-identity' });
  const result = await f.run.run([{ type: 'text', text: 'continue' }]);
  assert.equal(result.turn?.id, 'our-turn');
  assert.equal(f.calls.find((call) => call.method === 'thread/queue/add')?.params.clientUserMessageId,
    'browser-input-identity');
});

test('desktop queue preserves images and native identity without starting/resuming/forking a competing writer', async () => {
  const f = fixture();
  const input = [
    { type: 'text', text: 'Read the attached image.' },
    { type: 'localImage', path: 'C:/Users/owner/.cloudcli/assets/photo.png' },
  ];
  const result = await f.run.run(input);
  assert.equal(result.turn?.id, 'our-turn');
  assert.equal(result.turn?.status, 'completed');
  assert.deepEqual(f.started, ['our-turn']);
  assert.deepEqual(f.items.map(item => item.text), ['DESKTOP_REPLY']);
  assert.deepEqual(f.calls.find(call => call.method === 'thread/queue/add')?.params.input, input);
  assert.ok(f.calls.every(call => call.params.threadId === 'desktop' || call.method === 'thread/loaded/list'));
  assert.ok(!f.calls.some(call => ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt'].includes(call.method)));
  assert.ok(f.calls.filter(call => call.method === 'thread/turns/list').every(call => call.params.itemsView === 'full'));
  assert.ok(!f.calls.some(call => call.method === 'thread/items/list'), 'Legacy owners need no item pagination support');
});

test('cancellation removes only the correlated, still-pending submission', async () => {
  const f = fixture({ pending: true });
  const completion = f.run.run([{ type: 'text', text: 'Queued input' }]);
  await f.asleep;
  assert.equal(await f.run.cancel(), true);
  f.wake();
  assert.deepEqual(await completion, { turn: null, cancelled: true });
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/delete').length, 1);
  assert.ok(!f.calls.some(call => call.method === 'turn/interrupt'));
});

test('a refused or unconfirmed queue deletion is not a successful Stop', async () => {
  for (const deleteAck of [false, null]) {
    const f = fixture({ pending: true, deleteAck });
    const completion = f.run.run([{ type: 'text', text: 'Claimed concurrently by the desktop' }]);
    await f.asleep;
    assert.equal(await f.run.cancel(), false);
    f.claim();
    const result = await completion;
    assert.equal(result.cancelled, false);
    assert.equal(result.turn?.id, 'our-turn');
    assert.ok(!f.calls.some(call => call.method === 'turn/interrupt'));
  }
});

test('a shared daemon can relay to a different desktop owner without claiming its thread', async () => {
  const f = fixture({ sharedDaemon: true });
  assert.equal((await f.run.run([{ type: 'text', text: 'Use the existing desktop writer' }])).turn?.status, 'completed');
  assert.deepEqual(f.items.map(item => item.text), ['DESKTOP_REPLY']);
  assert.ok(!f.calls.some(call => ['thread/resume', 'turn/start', 'turn/interrupt'].includes(call.method)));
  const unsafe = fixture({ sharedDaemon: true, loaded: true });
  await assert.rejects(unsafe.run.run([{ type: 'text', text: 'Never claim a writer' }]), {
    code: 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR',
  });
});

test('cancellation during queue preflight does not submit the prompt afterwards', async () => {
  const f = fixture();
  const completion = f.run.run([{ type: 'text', text: 'Cancel before enqueue' }]);
  assert.equal(await f.run.cancel(), true);
  assert.deepEqual(await completion, { turn: null, cancelled: true });
  assert.ok(!f.calls.some(call => call.method === 'thread/queue/add'));
});

test('a started desktop turn is never interrupted through the observer connection', async () => {
  const f = fixture();
  await f.run.run([{ type: 'text', text: 'Queued input' }]);
  assert.equal(await f.run.cancel(), false);
  assert.ok(!f.calls.some(call => ['thread/queue/delete', 'turn/interrupt'].includes(call.method)));
});

test('an unfinished foreign-process snapshot is not mistaken for an interrupted/completed turn', async () => {
  const f = fixture({ transientInterrupted: true });
  let settled = false;
  const completion = f.run.run([{ type: 'text', text: 'Wait for the real desktop result' }]).then(result => {
    settled = true;
    return result;
  });
  await f.asleep;
  assert.equal(settled, false);
  assert.deepEqual([...f.items], []);
  f.wake();
  assert.equal((await completion).turn?.status, 'completed');
  assert.deepEqual(f.items.map(item => item.text), ['DESKTOP_REPLY']);
});

test('lost enqueue acknowledgement never retries or starts an alternate writer', async () => {
  const f = fixture({ lostAck: true });
  await assert.rejects(f.run.run([{ type: 'text', text: 'Submit once' }]), { code: 'CODEX_DESKTOP_QUEUE_UNCONFIRMED' });
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  assert.ok(!f.calls.some(call => ['turn/start', 'thread/start', 'thread/fork'].includes(call.method)));
});

test('wrong desktop identity is rejected before queue mutation', async () => {
  const f = fixture({ wrongThread: true });
  await assert.rejects(f.run.run([{ type: 'text', text: 'Never send' }]), { code: 'CODEX_DESKTOP_QUEUE_UNAVAILABLE' });
  assert.ok(!f.calls.some(call => call.method === 'thread/queue/add'));
});

test('an observer that loaded a writer or returns incomplete turn items cannot report success', async () => {
  for (const options of [{ loaded: true }, { incompleteItems: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run.run([{ type: 'text', text: 'Bounded observation' }]), { code: 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR' });
    assert.deepEqual(f.items, []);
  }
});

function ownerFixture(options: {
  noOwner?: boolean; previousStatus?: string; active?: boolean; source?: string;
  pendingClientId?: string; lostAck?: boolean; neverStarts?: boolean;
} = {}) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const emitted: AnyRecord[] = [];
  const input = [{ type: 'text', text: 'Continue after the desktop was stopped' }];
  const clientId = 'same-browser-input';
  let started = false;
  let queued = false;
  let now = 0;
  const client: ICodexRpcClient = {
    ownsProcess: true,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: 'desktop', source: options.source ?? 'vscode' } };
      if (method === 'thread/loaded/list') return { data: [] };
      if (method === 'thread/queue/list') return { data: options.pendingClientId
        ? [{ id: 'old-queued-input', clientUserMessageId: options.pendingClientId, input }]
        : queued ? [{ id: 'new-queued-input', clientUserMessageId: clientId, input }] : [], nextCursor: null };
      if (method === 'thread/queue/add') {
        queued = true;
        if (options.active) started = true;
        return { queuedSubmission: { id: 'new-queued-input', clientUserMessageId: clientId } };
      }
      if (method === 'thread/turns/list') return {
        data: [
          ...(started && !options.neverStarts ? [{
            id: 'desktop-owner-turn', status: 'completed', completedAt: 200, items: [
              { id: 'desktop-user', type: 'userMessage', clientId },
              { id: 'desktop-answer', type: 'agentMessage', text: 'The original owner continued' },
            ],
          }] : []),
          { id: 'stopped-turn', status: options.previousStatus ?? 'interrupted',
            completedAt: options.active ? null : 100, items: [] },
        ], nextCursor: null,
      };
      assert.fail(`Unsafe or unexpected observer operation: ${method}`);
    },
    onNotification: () => () => {}, onServerRequest: () => () => {},
    onDisconnect: () => () => {}, close: () => {},
  };
  const owner: ICodexDesktopThreadOwner = {
    async startTurn(items, id) {
      calls.push({ method: 'owner/start', params: { input: items, clientUserMessageId: id } });
      assert.equal(id, clientId);
      assert.deepEqual(items, input);
      started = true;
      if (options.lostAck) throw new Error('Unconfirmed owner outcome; never retry');
    },
    close: () => {},
  };
  const run = new CodexNativeQueueRun(client, 'desktop', {
    started: () => {}, item: item => emitted.push(item),
  }, {
    owner: options.noOwner ? null : owner, clientMessageId: clientId,
    clock: () => now, startupTimeoutMs: 2000, sleep: async () => { now += 1500; },
  });
  return { run, calls, input, emitted };
}

test('an interrupted desktop is continued through its verified owner, not its paused queue', async () => {
  for (const previousStatus of ['interrupted', 'failed', 'completed']) {
    const f = ownerFixture({ previousStatus });
    const result = await f.run.run(f.input);
    assert.equal(result.turn?.id, 'desktop-owner-turn');
    assert.deepEqual(f.emitted.map(item => item.text), ['The original owner continued']);
    assert.equal(f.calls.filter(call => call.method === 'owner/start').length, 1);
    assert.ok(!f.calls.some(call => ['thread/queue/add', 'thread/queue/delete', 'thread/resume', 'turn/start'].includes(call.method)));
  }
});

test('verified desktop ownership also covers a legacy Codey-created exec thread without rewriting its source', async () => {
  const f = ownerFixture({ source: 'exec' });
  assert.equal((await f.run.run(f.input)).turn?.status, 'completed');
  assert.equal(f.calls.filter(call => call.method === 'owner/start').length, 1);
});

test('without an owner channel a paused native queue is rejected before adding another message', async () => {
  const f = ownerFixture({ noOwner: true });
  await assert.rejects(f.run.run(f.input), { code: 'CODEX_DESKTOP_QUEUE_PAUSED' });
  assert.ok(!f.calls.some(call => ['owner/start', 'thread/queue/add', 'thread/queue/delete'].includes(call.method)));
});

test('an idle compatibility queue cannot silently wait a whole day without starting', async () => {
  const f = ownerFixture({ noOwner: true, previousStatus: 'completed' });
  await assert.rejects(f.run.run(f.input), { code: 'CODEX_DESKTOP_QUEUE_NOT_STARTED' });
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  assert.ok(!f.calls.some(call => ['owner/start', 'thread/queue/delete'].includes(call.method)));
});

test('active desktop work still receives queued input, never a competing direct turn', async () => {
  const f = ownerFixture({ active: true });
  assert.equal((await f.run.run(f.input)).turn?.status, 'completed');
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  assert.ok(!f.calls.some(call => call.method === 'owner/start'));
});

test('an existing native queue is neither leapfrogged nor replayed, even with the same client ID', async () => {
  for (const pendingClientId of ['someone-else', 'same-browser-input']) {
    const f = ownerFixture({ pendingClientId });
    await assert.rejects(f.run.run(f.input), { code: 'CODEX_DESKTOP_QUEUE_PENDING' });
    assert.ok(!f.calls.some(call => ['owner/start', 'thread/queue/add', 'thread/queue/delete'].includes(call.method)));
  }
});

test('lost owner acknowledgement never falls back to queueing or another writer', async () => {
  const f = ownerFixture({ lostAck: true });
  await assert.rejects(f.run.run(f.input), /Unconfirmed owner outcome/);
  assert.equal(f.calls.filter(call => call.method === 'owner/start').length, 1);
  assert.ok(!f.calls.some(call => ['thread/queue/add', 'thread/queue/delete', 'thread/resume', 'turn/start'].includes(call.method)));
});

test('cancellation during owner preflight submits nothing and never interrupts the desktop', async () => {
  const f = ownerFixture();
  const completion = f.run.run(f.input);
  assert.equal(await f.run.cancel(), true);
  assert.deepEqual(await completion, { turn: null, cancelled: true });
  assert.ok(!f.calls.some(call => ['owner/start', 'thread/queue/add', 'turn/interrupt'].includes(call.method)));
});
