import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord, ICodexDesktopThreadOwner, ICodexRpcClient, ProviderRuntimeContext } from '@/shared/index.js';

// Private stdio helper + independent desktop peer: unlike the Linux daemon
// fixture, the history reader cannot steer, interrupt, resume or own a thread.
function fixture({ idle = false } = {}) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const ownerCalls: Array<{ method: string; params: AnyRecord }> = [];
  const messages: AnyRecord[] = [];
  const disconnectListeners = new Set<() => void>();
  let connected = true;
  let closed = false;
  let turn: AnyRecord = {
    id: idle ? 'previous-turn' : 'desktop-turn', status: idle ? 'completed' : 'interrupted',
    startedAt: 1_789_913_000, completedAt: idle ? 1_789_913_010 : null, itemsView: 'full',
    items: [{ id: 'desktop-input', type: 'userMessage', clientId: 'desktop-original',
      content: [{ type: 'text', text: 'Desktop task' }] }],
  };
  let activeTurnId: string | null = idle ? null : turn.id;
  let steerError: Error | null = null;
  const finish = (status = 'completed') => {
    activeTurnId = null;
    turn.status = status;
    turn.completedAt = 1_789_913_020;
  };
  const helper: ICodexRpcClient = {
    ownsProcess: true,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: 'desktop-thread', source: 'vscode', cwd: '/workspace' } };
      if (method === 'thread/loaded/list') return { data: [] };
      if (method === 'thread/turns/list') return { data: [structuredClone(turn)], nextCursor: null };
      if (method === 'thread/queue/list') return { data: [], nextCursor: null };
      assert.fail(`A read-only helper must not receive ${method}`);
    },
    onNotification: () => () => {}, onServerRequest: () => () => {},
    onDisconnect: () => () => {}, close: () => { closed = true; },
  };
  const owner: ICodexDesktopThreadOwner = {
    get connected() { return connected; },
    async readState() {
      ownerCalls.push({ method: 'readState', params: {} });
      return { activeTurnId, cwd: '/workspace' };
    },
    async startTurn(input, clientUserMessageId) {
      ownerCalls.push({ method: 'startTurn', params: { input, clientUserMessageId } });
      assert.equal(activeTurnId, null);
      activeTurnId = 'continued-turn';
      turn = {
        ...turn, id: activeTurnId, status: 'interrupted', completedAt: null,
        items: [{ id: 'codey-input', type: 'userMessage', clientId: clientUserMessageId, content: input }],
      };
    },
    async steerTurn(expectedTurnId, input, clientUserMessageId) {
      ownerCalls.push({ method: 'steerTurn', params: { expectedTurnId, input, clientUserMessageId } });
      assert.equal(expectedTurnId, activeTurnId);
      if (steerError) throw steerError;
      turn.items.push({ id: `native-${clientUserMessageId}`, type: 'userMessage', clientId: clientUserMessageId, content: input });
    },
    async interruptTurn(expectedTurnId) {
      ownerCalls.push({ method: 'interruptTurn', params: { expectedTurnId } });
      if (expectedTurnId !== activeTurnId) return false;
      finish('interrupted');
      return true;
    },
    onDisconnect(listener) { disconnectListeners.add(listener); return () => { disconnectListeners.delete(listener); }; },
    close() { connected = false; },
  };
  const runtime = new CodexSharedRuntime({
    run: async () => { assert.fail('Never start exec for a desktop-owned thread'); },
    abort: async () => { assert.fail('Never stop another runtime'); },
  }, async () => helper, async () => { assert.fail('Never create a replacement writer'); }, async () => owner);
  const provider = new CodexSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'desktop-thread',
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ DEFAULT: '', OPTIONS: [] }),
    normalizeMessage: (raw, id) => provider.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
  };
  const writer = { isWebSocketWriter: true, send: (value: unknown) => { messages.push(value as AnyRecord); } };
  return {
    runtime, helper, owner, context, writer, calls, ownerCalls, messages, finish,
    closed: () => closed,
    changeTurn: () => { activeTurnId = 'later-turn'; },
    rejectSteer: (error: Error) => { steerError = error; },
    desktopInput: () => {
      turn.items.push({ id: 'desktop-correction', type: 'userMessage', clientId: 'desktop-second',
        content: [{ type: 'text', text: 'Desktop can still send' }] });
    },
    disconnect: () => { connected = false; for (const listener of disconnectListeners) listener(); },
  };
}

async function ready(runtime: CodexSharedRuntime): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!runtime.canSteer('app')) {
    if (Date.now() >= deadline) assert.fail('Desktop steering was not advertised');
    await sleep(5);
  }
}

test('joining a private-stdio desktop turn enables queue/steer/Stop without loading its writer', async () => {
  const f = fixture();
  f.context.resolveResumeModel = async () => assert.fail('Observation must not select a model');
  f.context.getProviderModels = async () => assert.fail('Observation must not require a catalog');
  const observation = await f.runtime.prepareObservation('app', f.context);
  assert.ok(observation);
  const running = observation.start(f.writer);
  try {
    await ready(f.runtime);
    assert.equal(f.runtime.canInterrupt('app'), true);
    assert.ok(f.messages.some(x => x.canSteer === true && x.canInterrupt === true));
    assert.ok(!f.ownerCalls.some(x => ['startTurn', 'steerTurn', 'interruptTurn'].includes(x.method)));
    f.desktopInput();
    await f.runtime.steer('app', 'Codey correction', {
      clientMessageId: 'codey-correction', model: 'ignored', permissionMode: 'bypassPermissions',
      images: [{ path: '/workspace/upload.png' }],
    });
    assert.deepEqual(f.ownerCalls.find(x => x.method === 'steerTurn')?.params, {
      expectedTurnId: 'desktop-turn',
      input: [{ type: 'text', text: 'Codey correction' }, { type: 'localImage', path: '/workspace/upload.png' }],
      clientUserMessageId: 'codey-correction',
    });
    assert.equal(f.runtime.canSteer('app'), true);
  } finally { f.finish(); await running; }
  const userIds = f.messages.filter(x => x.role === 'user').map(x => x.clientMessageId);
  assert.deepEqual(userIds, ['desktop-original', 'desktop-second', 'codey-correction']);
  assert.deepEqual(f.messages.find(x => x.clientMessageId === 'codey-correction')?.nativePosition, {
    turnId: 'desktop-turn', turnStartedAt: new Date(1_789_913_000_000).toISOString(), itemIndex: 2,
  });
  assert.equal(f.messages.filter(x => x.kind === 'complete').length, 1);
  assert.equal(f.closed(), true);
  assert.equal(f.runtime.canSteer('app'), false);
});

test('an idle desktop owner is preferred before resume so Codey does not block desktop input', async () => {
  const f = fixture({ idle: true });
  const running = f.runtime.run('Continue the shared thread', {
    sessionId: 'app', clientMessageId: 'continued-input',
  }, f.writer, f.context);
  try {
    await ready(f.runtime);
    assert.deepEqual(f.ownerCalls.find(x => x.method === 'startTurn')?.params, {
      input: [{ type: 'text', text: 'Continue the shared thread' }], clientUserMessageId: 'continued-input',
    });
    f.desktopInput();
    await f.runtime.steer('app', 'More detail', { clientMessageId: 'followup' });
    assert.equal(f.ownerCalls.find(x => x.method === 'steerTurn')?.params.expectedTurnId, 'continued-turn');
    assert.ok(!f.calls.some(x => ['thread/resume', 'turn/start', 'thread/queue/add'].includes(x.method)));
  } finally { f.finish(); await running; }
  assert.equal(f.messages.at(-1)?.success, true);
  assert.ok(f.messages.some(x => x.clientMessageId === 'desktop-second'));
});

test('an ordinary send reaching an already active owner appends once and keeps both clients on the same turn', async () => {
  const f = fixture();
  const running = f.runtime.run('Same-turn input', {
    sessionId: 'app', clientMessageId: 'same-turn-input',
  }, f.writer, f.context);
  try {
    await ready(f.runtime);
    assert.equal(f.ownerCalls.filter(x => x.method === 'steerTurn').length, 1);
    assert.equal(f.ownerCalls.find(x => x.method === 'steerTurn')?.params.expectedTurnId, 'desktop-turn');
    assert.ok(!f.ownerCalls.some(x => x.method === 'startTurn'));
    assert.ok(!f.calls.some(x => ['thread/resume', 'turn/start', 'thread/queue/add'].includes(x.method)));
  } finally { f.finish(); await running; }
});

test('only an explicit run-bound Stop may interrupt a desktop-owned peer turn', async () => {
  const f = fixture();
  const observation = await f.runtime.prepareObservation('app', f.context);
  assert.ok(observation);
  const running = observation.start(f.writer);
  try {
    await ready(f.runtime);
    await assert.rejects(f.runtime.abort('app'), { code: 'CODEX_DESKTOP_TURN_NOT_OWNED' });
    assert.ok(!f.ownerCalls.some(x => x.method === 'interruptTurn'));
    assert.equal(await f.runtime.abort('app', { allowExternalTurn: true }), true);
    assert.deepEqual(f.ownerCalls.find(x => x.method === 'interruptTurn')?.params, { expectedTurnId: 'desktop-turn' });
  } finally { f.finish('interrupted'); await running; }
  assert.equal(f.messages.filter(x => x.kind === 'complete').length, 1);
  assert.ok(!f.calls.some(x => x.method === 'turn/interrupt'));
});

test('a desktop turn changing between preparation and attachment never sends or starts a prompt', async () => {
  const f = fixture();
  const observation = await f.runtime.prepareObservation('app', f.context);
  assert.ok(observation);
  f.changeTurn();
  await observation.start(f.writer);
  assert.match(f.messages.find(x => x.kind === 'error')?.content, /ended or changed/);
  assert.ok(!f.ownerCalls.some(x => ['startTurn', 'steerTurn', 'interruptTurn'].includes(x.method)));
  assert.equal(f.calls.length, 0);
  assert.equal(f.closed(), true);
});

test('desktop disconnect disables controls immediately without interrupting or replaying its work', async () => {
  const f = fixture();
  const observation = await f.runtime.prepareObservation('app', f.context);
  assert.ok(observation);
  const running = observation.start(f.writer);
  try {
    await ready(f.runtime);
    f.disconnect();
    assert.equal(f.runtime.canSteer('app'), false);
    assert.equal(f.runtime.canInterrupt('app'), false);
    assert.equal(f.messages.at(-1)?.canSteer, false);
    await assert.rejects(f.runtime.steer('app', 'Do not replay', {}), { code: 'STEER_UNAVAILABLE' });
    assert.ok(!f.ownerCalls.some(x => ['startTurn', 'steerTurn', 'interruptTurn'].includes(x.method)));
  } finally { f.finish(); await running; }
});

test('an uncertain peer steer acknowledgement does not end the original run or retry input', async () => {
  const f = fixture();
  const observation = await f.runtime.prepareObservation('app', f.context);
  assert.ok(observation);
  const running = observation.start(f.writer);
  try {
    await ready(f.runtime);
    f.rejectSteer(new AppError('Check the original transcript', { code: 'STEER_UNCONFIRMED' }));
    await assert.rejects(f.runtime.steer('app', 'Exactly once', { clientMessageId: 'once' }), { code: 'STEER_UNCONFIRMED' });
    assert.equal(f.runtime.canSteer('app'), true);
    assert.equal(f.ownerCalls.filter(x => x.method === 'steerTurn').length, 1);
    assert.ok(!f.messages.some(x => x.kind === 'complete' || x.kind === 'error'));
    assert.ok(!f.calls.some(x => x.method === 'thread/queue/add'));
  } finally { f.finish(); await running; }
});

test('idle observation and a disposed preparation close only their own reader and peer connections', async () => {
  const idle = fixture({ idle: true });
  assert.equal(await idle.runtime.prepareObservation('app', idle.context), null);
  assert.equal(idle.closed(), true);
  assert.equal(idle.owner.connected, false);
  const active = fixture();
  const observation = await active.runtime.prepareObservation('app', active.context);
  assert.ok(observation);
  await observation.dispose();
  assert.equal(active.closed(), true);
  assert.equal(active.owner.connected, false);
  assert.equal(active.calls.length, 0);
  assert.ok(!active.ownerCalls.some(x => ['startTurn', 'steerTurn', 'interruptTurn'].includes(x.method)));
});
