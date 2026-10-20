import assert from 'node:assert/strict';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createClaudeSessionTitleService } from '@/modules/providers/list/claude/claude-session-title.service.js';
import type { NewSessionTitleRequest } from '@/shared/index.js';

const REQUEST: NewSessionTitleRequest = {
  sessionId: 'codey-app', providerSessionId: 'native-session', initialMessage: 'Find why my Mac node is offline',
};

function fixture() {
  const row = {
    session_id: REQUEST.sessionId, provider: 'claude', provider_session_id: REQUEST.providerSessionId,
    custom_name: 'Find why my Mac' as string | null, custom_name_source: 'auto' as 'auto' | 'user',
    forked_from_session_id: null as string | null, isArchived: 0, model: 'claude-opus-5.5' as string | null,
  };
  let exists = true;
  let generations = 0;
  const writes: unknown[][] = [];
  const notices: string[] = [];
  const warnings: string[] = [];
  const dependencies: NonNullable<Parameters<typeof createClaudeSessionTitleService>[0]> = {
    getSession: () => exists ? { ...row } : null,
    generate: async input => {
      generations++;
      assert.equal(input.model, 'claude-opus-5.5');
      assert.equal(input.message, REQUEST.initialMessage);
      assert.equal(input.signal.aborted, false);
      return 'Investigate offline Mac node';
    },
    updateTitle: (...args) => { writes.push(args); return true; },
    notify: async id => { notices.push(id); },
    warn: message => { warnings.push(message); },
  };
  return {
    row, dependencies, writes, notices, warnings,
    remove: () => { exists = false; },
    generations: () => generations,
  };
}

test('a new managed Claude session gets one generated title cached as automatic and broadcast', async () => {
  const f = fixture();
  await createClaudeSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.equal(f.generations(), 1);
  assert.deepEqual(f.writes, [[REQUEST.sessionId, 'Investigate offline Mac node', REQUEST.providerSessionId]]);
  assert.deepEqual(f.notices, [REQUEST.sessionId]);
  assert.deepEqual(f.warnings, []);
});

for (const state of [
  'local rename', 'archive', 'removed', 'repointed', 'imported', 'fork', 'other provider', 'no model',
  'native title',
] as const) {
  for (const when of ['before generation', 'during generation'] as const) {
    if (state === 'native title' && when === 'before generation') continue;
    test(`${state} ${when} prevents automatic name writes`, async () => {
      const f = fixture();
      const mutate = () => {
        if (state === 'local rename') f.row.custom_name_source = 'user';
        if (state === 'archive') f.row.isArchived = 1;
        if (state === 'removed') f.remove();
        if (state === 'repointed') f.row.provider_session_id = 'another-session';
        if (state === 'imported') f.row.session_id = REQUEST.providerSessionId;
        if (state === 'fork') f.row.forked_from_session_id = 'source';
        if (state === 'other provider') f.row.provider = 'codex';
        if (state === 'no model') f.row.model = null;
        // The synchronizer adopted a native /rename while the model worked.
        if (state === 'native title') f.row.custom_name = 'Native rename';
      };
      if (when === 'before generation') mutate();
      else f.dependencies.generate = async () => { mutate(); return 'Generated title'; };
      await createClaudeSessionTitleService(f.dependencies).schedule(REQUEST);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.notices, []);
      if (when === 'before generation') assert.equal(f.generations(), 0);
    });
  }
}

test('a rename that wins the database race is not broadcast as a generated title', async () => {
  const f = fixture();
  f.dependencies.updateTitle = (...args) => { f.writes.push(args); return false; };
  await createClaudeSessionTitleService(f.dependencies).schedule(REQUEST);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.notices, []);
});

test('failed requests and unusable output only skip naming, without disclosing private text', async () => {
  for (const mode of ['failure', 'no-title', 'notify-failure'] as const) {
    const f = fixture();
    if (mode === 'notify-failure') f.dependencies.notify = async () => { throw new Error('secret broadcast'); };
    else f.dependencies.generate = async () => {
      if (mode === 'failure') throw new Error('secret credential');
      return null;
    };
    await createClaudeSessionTitleService(f.dependencies).schedule(REQUEST);
    assert.equal(f.writes.length, mode === 'notify-failure' ? 1 : 0);
    assert.equal(f.warnings.length, mode === 'no-title' ? 0 : 1);
    assert.ok(f.warnings.every(message => !/secret|Mac node/.test(message)));
  }
});

test('a title that arrives after the deadline is never written', async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.dependencies.generate = async input => {
    signal = input.signal;
    await delay(20);
    return 'Too late';
  };
  await createClaudeSessionTitleService({ ...f.dependencies, timeoutMs: 5 }).schedule(REQUEST);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(f.writes, []);
  assert.equal(f.warnings.length, 1);
});

test('duplicate creation events share one job; blank messages do no work; input is bounded', async () => {
  const f = fixture();
  const messages: string[] = [];
  f.dependencies.generate = async input => { messages.push(input.message); return 'Title'; };
  const service = createClaudeSessionTitleService(f.dependencies);
  const first = service.schedule({ ...REQUEST, initialMessage: `  ${'长'.repeat(5_000)}  ` });
  assert.equal(service.schedule(REQUEST), first);
  await first;
  await service.schedule({ ...REQUEST, initialMessage: ' ' });
  assert.deepEqual(messages.map(message => message.length), [4_000]);
});

test('background title work is bounded to two requests and 32 queued jobs', async () => {
  let live = 0;
  let maximumLive = 0;
  let generations = 0;
  let openGate = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  const service = createClaudeSessionTitleService({
    getSession: id => ({
      session_id: id, provider: 'claude', provider_session_id: `native-${id}`, custom_name: 'A task',
      custom_name_source: 'auto', isArchived: 0, forked_from_session_id: null, model: 'claude-opus-5.5',
    }),
    generate: async () => {
      generations++;
      live++;
      maximumLive = Math.max(maximumLive, live);
      await gate;
      live--;
      return 'A generated title';
    },
    updateTitle: () => true, notify: async () => {}, warn: () => {},
  });
  const jobs = Array.from({ length: 33 }, (_, index) => service.schedule({
    sessionId: `app-${index}`, providerSessionId: `native-app-${index}`, initialMessage: 'A task',
  }));
  await tick();
  assert.equal(generations, 2);
  openGate();
  await Promise.all(jobs);
  assert.equal(generations, 32);
  assert.equal(maximumLive, 2);
});
