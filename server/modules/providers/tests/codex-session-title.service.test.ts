import assert from 'node:assert/strict';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createCodexSessionTitleService } from '@/modules/providers/list/codex/codex-session-title.service.js';
import type { AnyRecord, ICodexRpcClient, NewCodexSessionTitleRequest } from '@/shared/index.js';

const REQUEST: NewCodexSessionTitleRequest = {
  sessionId: 'codey-app', providerSessionId: 'native-thread', initialMessage: 'Find why my Mac node is offline',
};

function fixture() {
  const row = {
    session_id: REQUEST.sessionId, provider: 'codex', provider_session_id: REQUEST.providerSessionId,
    project_path: '/workspace/demo', custom_name_source: 'auto' as 'auto' | 'user',
    forked_from_session_id: null as string | null, isArchived: 0, model: 'selected-model',
  };
  let nativeName: string | null = null;
  let exists = true;
  let closed = 0;
  let connections = 0;
  let generations = 0;
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const writes: unknown[][] = [];
  const notices: string[] = [];
  const warnings: string[] = [];
  const listeners = new Set<(method: string, params: AnyRecord) => void>();
  const disconnects = new Set<(error: Error) => void>();
  const client: ICodexRpcClient = {
    ownsProcess: true,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/read') return {
        thread: { id: REQUEST.providerSessionId, name: nativeName, modelProvider: 'fixture' },
      };
      if (method === 'config/read') return { config: { model: 'default-model', model_provider: 'fixture' } };
      if (method === 'thread/name/set') {
        nativeName = params.name;
        for (const fn of listeners) fn('thread/name/updated', { threadId: REQUEST.providerSessionId, threadName: nativeName });
        return {};
      }
      assert.fail(`Unexpected native operation: ${method}`);
    },
    onNotification: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onServerRequest: () => () => {},
    onDisconnect: fn => { disconnects.add(fn); return () => { disconnects.delete(fn); }; },
    close: () => { closed++; },
  };
  const dependencies: NonNullable<Parameters<typeof createCodexSessionTitleService>[0]> = {
    connect: async () => { connections++; return client; },
    getSession: () => exists ? row : null,
    generate: async input => {
      generations++;
      assert.equal(input.model, 'selected-model');
      assert.equal(input.modelProvider, 'fixture');
      assert.equal(input.message, REQUEST.initialMessage);
      return 'Investigate offline Mac node';
    },
    updateTitle: (...args) => { writes.push(args); return true; },
    notify: async id => { notices.push(id); },
    warn: message => { warnings.push(message); },
  };
  return {
    row, client, dependencies, calls, writes, notices, warnings, listeners, disconnects,
    setName: (name: string | null) => { nativeName = name; },
    remove: () => { exists = false; },
    stats: () => ({ nativeName, closed, connections, generations }),
  };
}

test('new Codey titles are generated and written through metadata RPC without loading or turning a thread', async () => {
  const f = fixture();
  const service = createCodexSessionTitleService(f.dependencies);
  await service.schedule(REQUEST);
  assert.deepEqual(f.calls.map(call => call.method), [
    'thread/read', 'config/read', 'thread/read', 'thread/name/set', 'thread/read',
  ]);
  assert.ok(f.calls.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === false));
  assert.deepEqual(f.calls.find(call => call.method === 'config/read')?.params,
    { cwd: '/workspace/demo', includeLayers: false });
  assert.deepEqual(f.writes, [[REQUEST.sessionId, 'Investigate offline Mac node', REQUEST.providerSessionId]]);
  assert.deepEqual(f.notices, [REQUEST.sessionId]);
  assert.equal(f.row.custom_name_source, 'auto');
  assert.deepEqual(f.stats(), { nativeName: 'Investigate offline Mac node', closed: 1, connections: 1, generations: 1 });
  assert.equal(f.listeners.size, 0);
});

test('losing the native metadata connection cancels pending title work and releases subscriptions', async () => {
  const f = fixture();
  f.dependencies.generate = async ({ signal }) => {
    for (const disconnect of f.disconnects) disconnect(new Error('disconnected'));
    assert.equal(signal.aborted, true);
    return new Promise(() => {});
  };
  await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.deepEqual(f.writes, []);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.disconnects.size, 0);
  assert.equal(f.stats().closed, 1);
});

test('an existing native title is neither summarized again nor overwritten', async () => {
  const f = fixture();
  f.setName('Desktop name');
  await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.equal(f.stats().generations, 0);
  assert.equal(f.stats().nativeName, 'Desktop name');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls.map(call => call.method), ['thread/read']);
});

for (const state of ['local rename', 'archive', 'removed', 'repointed', 'imported', 'fork', 'other provider'] as const) {
  for (const when of ['before generation', 'during generation'] as const) {
    test(`${state} ${when} prevents automatic name writes`, async () => {
      const f = fixture();
      const mutate = () => {
        if (state === 'local rename') f.row.custom_name_source = 'user';
        if (state === 'archive') f.row.isArchived = 1;
        if (state === 'removed') f.remove();
        if (state === 'repointed') f.row.provider_session_id = 'another-thread';
        if (state === 'imported') f.row.session_id = REQUEST.providerSessionId;
        if (state === 'fork') f.row.forked_from_session_id = 'source';
        if (state === 'other provider') f.row.provider = 'claude';
      };
      if (when === 'before generation') mutate();
      else f.dependencies.generate = async () => { mutate(); return 'Generated title'; };
      await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
      assert.deepEqual(f.writes, []);
      assert.ok(!f.calls.some(call => call.method === 'thread/name/set'));
      if (when === 'before generation') assert.equal(f.stats().connections, 0);
    });
  }
}

test('a desktop rename during generation is caught by a fresh metadata read even without notifications', async () => {
  const f = fixture();
  f.dependencies.generate = async () => { f.setName('Manual desktop name'); return 'Generated title'; };
  await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.equal(f.stats().nativeName, 'Manual desktop name');
  assert.ok(!f.calls.some(call => call.method === 'thread/name/set'));
});

test('a native rename notification cancels generation without waiting for an unresponsive model', async () => {
  const f = fixture();
  f.dependencies.generate = async ({ signal }) => {
    for (const listener of f.listeners) listener('thread/name/updated', {
      threadId: REQUEST.providerSessionId, threadName: 'Desktop rename',
    });
    assert.equal(signal.aborted, true);
    return new Promise(() => {});
  };
  await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.ok(!f.calls.some(call => call.method === 'thread/name/set'));
  assert.equal(f.stats().closed, 1);
});

test('the name RPC is never retried after an ambiguous acknowledgement', async () => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/name/set') throw new Error('private provider response');
    return result;
  };
  await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.equal(f.calls.filter(call => call.method === 'thread/name/set').length, 1);
  assert.deepEqual(f.writes, []);
  assert.equal(f.warnings.some(message => message.includes('private provider response')), false);
  assert.equal(f.stats().closed, 1);
});

test('only a confirmed persisted native name is reflected back into Codey', async () => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/name/set') f.setName('Newer native name');
    return result;
  };
  await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.notices, []);
});

test('failed model requests, unsupported backends and empty output only skip background naming', async () => {
  for (const mode of ['failure', 'no-client', 'no-title'] as const) {
    const f = fixture();
    if (mode === 'no-client') f.dependencies.connect = async () => null;
    else f.dependencies.generate = async () => {
      if (mode === 'failure') throw new Error('secret credential');
      return null;
    };
    await createCodexSessionTitleService(f.dependencies).schedule(REQUEST);
    assert.deepEqual(f.writes, []);
    assert.ok(!f.calls.some(call => call.method === 'thread/name/set'));
    assert.equal(f.warnings.some(message => message.includes('secret credential')), false);
  }
});

test('duplicate creation events share one title job and blank messages do no work', async () => {
  const f = fixture();
  const service = createCodexSessionTitleService(f.dependencies);
  const first = service.schedule(REQUEST);
  const duplicate = service.schedule(REQUEST);
  assert.equal(duplicate, first);
  await first;
  await service.schedule({ ...REQUEST, initialMessage: ' ' });
  assert.equal(f.stats().generations, 1);
});

test('a timed-out handshake closes its late reader and never makes a late name write', async () => {
  const f = fixture();
  let resolveConnection!: (client: ICodexRpcClient) => void;
  f.dependencies.connect = () => new Promise(resolve => { resolveConnection = resolve; });
  const service = createCodexSessionTitleService({ ...f.dependencies, timeoutMs: 5 });
  await Promise.all([service.schedule(REQUEST), delay(15)]);
  resolveConnection(f.client);
  await tick();
  assert.equal(f.stats().closed, 1);
  assert.deepEqual(f.calls, []);
});

test('a timed-out model cannot write a title when it eventually finishes', async () => {
  const f = fixture();
  let finish!: (name: string) => void;
  let signal: AbortSignal | undefined;
  f.dependencies.generate = input => {
    signal = input.signal;
    return new Promise(resolve => { finish = resolve; });
  };
  const service = createCodexSessionTitleService({ ...f.dependencies, timeoutMs: 5 });
  await Promise.all([service.schedule(REQUEST), delay(15)]);
  assert.equal(signal?.aborted, true);
  finish('Too late');
  await tick();
  assert.ok(!f.calls.some(call => call.method === 'thread/name/set'));
  assert.equal(f.stats().closed, 1);
});

test('background title work is bounded to two readers and 32 queued jobs', async () => {
  let connections = 0;
  let live = 0;
  let maximumLive = 0;
  let titles = 0;
  let openGate = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  const service = createCodexSessionTitleService({
    connect: async () => {
      connections++;
      live++;
      maximumLive = Math.max(maximumLive, live);
      let name: string | null = null;
      return {
        request: async (method, params) => {
          if (method === 'thread/read') return { thread: { id: params.threadId, name, modelProvider: 'fixture' } };
          if (method === 'config/read') return { config: { model: 'fixture-model' } };
          if (method === 'thread/name/set') { name = params.name; titles++; return {}; }
          assert.fail(`Unexpected operation ${method}`);
        },
        onNotification: () => () => {}, onServerRequest: () => () => {}, onDisconnect: () => () => {},
        close: () => { live--; },
      };
    },
    getSession: id => ({
      session_id: id, provider: 'codex', provider_session_id: `native-${id}`,
      project_path: '/workspace/demo', model: 'fixture-model',
      custom_name_source: 'auto', isArchived: 0, forked_from_session_id: null,
    }),
    generate: async () => { await gate; return 'A generated title'; },
    updateTitle: () => true, notify: async () => {}, warn: () => {},
  });
  const jobs = Array.from({ length: 33 }, (_, index) => service.schedule({
    sessionId: `app-${index}`, providerSessionId: `native-app-${index}`, initialMessage: 'A task',
  }));
  await tick();
  assert.equal(connections, 2);
  openGate();
  await Promise.all(jobs);
  assert.equal(connections, 32);
  assert.equal(titles, 32);
  assert.equal(maximumLive, 2);
  assert.equal(live, 0);
});
