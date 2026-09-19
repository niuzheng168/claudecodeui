import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexNativeQueueRun } from '@/modules/providers/list/codex/codex-native-queue.service.js';
import type { AnyRecord, ICodexRpcClient } from '@/shared/index.js';

function fixture(options: { pending?: boolean; lostAck?: boolean; wrongThread?: boolean; loaded?: boolean; sharedDaemon?: boolean; incompleteItems?: boolean; transientInterrupted?: boolean; clientMessageId?: string } = {}) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const items: AnyRecord[] = [];
  const started: string[] = [];
  let clientId = '';
  let created = false;
  let deleted = false;
  let completed = !options.transientInterrupted;
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
          ...(created && !deleted && options.pending ? [{ id: 'our-queue', clientUserMessageId: clientId }] : []),
        ], nextCursor: null,
      };
      if (method === 'thread/queue/delete') {
        assert.equal(params.queuedSubmissionId, 'our-queue');
        deleted = true;
        return {};
      }
      if (method === 'thread/turns/list') return {
        data: [
          ...(created && !options.pending ? [
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
  return { run, calls, items, started, asleep, wake: () => { completed = true; sleeping?.(); } };
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
