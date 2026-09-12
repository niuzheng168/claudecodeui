import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexStdioPermissions } from '@/modules/providers/list/codex/codex-stdio-permissions.service.js';
import { parseCodexGoalCommand, readCodexGoal } from '@/modules/providers/list/codex/codex-goal.service.js';
import { createCodexCommandsService } from '@/modules/providers/services/codex-commands.service.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord, CodexGoal, ICodexRpcClient, ProviderRuntimeContext } from '@/shared/index.js';

function goal(status: CodexGoal['status'] = 'active', tokensUsed = 0): CodexGoal {
  return { threadId: 'native', objective: 'Finish the task', status, tokenBudget: null, tokensUsed, timeUsedSeconds: 1 };
}

class Client implements ICodexRpcClient {
  readonly ownsProcess = true;
  calls: Array<{ method: string; params: AnyRecord }> = [];
  listeners = new Set<(method: string, params: AnyRecord) => void>();
  requests = new Set<(method: string, params: AnyRecord, id?: number | string) => void>();
  state: CodexGoal | null = null;
  closed = false;
  override?: (method: string, params: AnyRecord) => Promise<AnyRecord | undefined>;
  async request(method: string, params: AnyRecord): Promise<AnyRecord> {
    this.calls.push({ method, params });
    const overridden = await this.override?.(method, params);
    if (overridden !== undefined) return overridden;
    if (method === 'thread/start' || method === 'thread/resume') {
      return { thread: { id: 'native', status: { type: 'idle' } } };
    }
    if (method === 'thread/goal/get') return { goal: this.state };
    if (method === 'thread/goal/clear') {
      this.state = null;
      this.emit('thread/goal/cleared', {});
      return { cleared: true };
    }
    if (method === 'thread/goal/set') {
      this.state = {
        ...(this.state ?? goal()),
        ...('objective' in params ? { objective: params.objective } : {}),
        ...('status' in params ? { status: params.status } : {}),
        ...('tokenBudget' in params ? { tokenBudget: params.tokenBudget } : {}),
      };
      this.emit('thread/goal/updated', { goal: this.state });
      return { goal: this.state };
    }
    if (method === 'turn/start') {
      // Exercise the existing early-event buffer for Plan Mode too.
      this.emit('item/started', { turnId: 'plan-turn', item: { id: 'plan-item', type: 'plan', text: '' } });
      this.emit('item/plan/delta', { turnId: 'plan-turn', itemId: 'plan-item', delta: 'A real plan' });
      this.emit('item/completed', { turnId: 'plan-turn', item: { id: 'plan-item', type: 'plan', text: 'A real plan' } });
      this.emit('turn/completed', { turn: { id: 'plan-turn', status: 'completed' } });
      return { turn: { id: 'plan-turn' } };
    }
    if (method === 'turn/interrupt') this.finish(params.turnId, 'interrupted');
    return {};
  }
  onNotification(listener: (method: string, params: AnyRecord) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onServerRequest(listener: (method: string, params: AnyRecord, id?: number | string) => void) { this.requests.add(listener); return () => this.requests.delete(listener); }
  onDisconnect() { return () => {}; }
  close() { this.closed = true; }
  emit(method: string, params: AnyRecord) {
    for (const listener of this.listeners) listener(method, { threadId: 'native', ...params });
  }
  start(id: string) { this.emit('turn/started', { turn: { id, status: 'inProgress' } }); }
  finish(id: string, status = 'completed') { this.emit('turn/completed', { turn: { id, status } }); }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Fixture did not reach the expected state');
}

function fixture(client = new Client()) {
  const messages: AnyRecord[] = [];
  let fallbackCalls = 0;
  const runtime = new CodexSharedRuntime({
    run: async () => { fallbackCalls++; }, abort: () => false,
  }, async () => client);
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'native',
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({
      DEFAULT: 'test-model',
      OPTIONS: [{ value: 'test-model', label: 'Test', effort: { values: [{ value: 'high', label: 'High' }], default: 'high' } }],
    }),
    normalizeMessage: (raw) => [raw as never],
    isProviderInstalled: async () => true,
  };
  const run = (command: string, options: AnyRecord = {}) => runtime.run(command, {
    sessionId: 'app', permissionMode: 'default', effort: 'high', ...options,
  }, { isWebSocketWriter: true, send: (value) => messages.push(value as AnyRecord) }, context);
  return { client, runtime, messages, context, run, fallbackCalls: () => fallbackCalls };
}

test('goal parser preserves multiline objectives and only uses explicitly supplied budgets', () => {
  assert.deepEqual(parseCodexGoalCommand('Write tests\nthen fix the bug'), { action: 'set', objective: 'Write tests\nthen fix the bug' });
  assert.deepEqual(parseCodexGoalCommand('--tokens 40000 Finish it'), { action: 'set', objective: 'Finish it', tokenBudget: 40000 });
  assert.deepEqual(parseCodexGoalCommand('resume'), { action: 'resume' });
  assert.deepEqual(parseCodexGoalCommand('budget off'), { action: 'budget', tokenBudget: null });
  assert.deepEqual(parseCodexGoalCommand('edit New task'), { action: 'set', objective: 'New task' });
  for (const text of ['--tokens 0 x', '--tokens -1 x', '--tokens 9007199254740992 x', 'resume extra', 'budget', 'x'.repeat(4001)]) {
    assert.throws(() => parseCodexGoalCommand(text), { code: 'INVALID_GOAL_COMMAND' });
  }
  assert.doesNotThrow(() => parseCodexGoalCommand('😀'.repeat(4000)));
  assert.throws(() => readCodexGoal({ ...goal(), threadId: 'foreign' }, 'native'), { code: 'CODEX_GOAL_INVALID_RESPONSE' });
});

test('goal run follows multiple native turns, ignoring foreign events and without submitting turn/start', async () => {
  const f = fixture();
  let done = false;
  const pending = f.run('/goal Finish the task').then(() => { done = true; });
  await until(() => f.client.calls.some((call) => call.method === 'thread/goal/set'));
  await delay(0);
  f.client.start('first');
  f.client.emit('item/completed', { turnId: 'first', item: { id: 'one', type: 'agentMessage', text: 'First answer' } });
  f.client.finish('first');
  await delay(0);
  assert.equal(done, false, 'A final answer is not goal completion');
  assert.equal(f.client.closed, false);
  f.client.emit('thread/goal/updated', { threadId: 'foreign', goal: goal('complete') });
  f.client.emit('turn/completed', { threadId: 'foreign', turn: { id: 'foreign', status: 'completed' } });
  f.client.start('second');
  f.client.emit('item/completed', { turnId: 'second', item: { id: 'two', type: 'agentMessage', text: 'Second answer' } });
  f.client.state = goal('complete', 42);
  f.client.emit('thread/goal/updated', { goal: f.client.state });
  assert.equal(done, false, 'The final turn must still drain');
  f.client.finish('second');
  await pending;
  assert.equal(f.client.closed, true);
  assert.equal(f.client.calls.filter((call) => call.method === 'thread/goal/set').length, 1);
  assert.ok(!f.client.calls.some((call) => call.method === 'turn/start'));
  assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 1);
  assert.ok(f.messages.some((message) => message.message?.content === 'Second answer'));
  assert.ok(f.messages.some((message) => message.summary?.includes('42')));
  assert.equal(f.fallbackCalls(), 0);
});

test('pause can be acknowledged during a goal run and waits for its current turn to drain', async () => {
  const f = fixture();
  f.client.state = goal('paused');
  const pending = f.run('/goal resume');
  await until(() => f.client.calls.some((call) => call.method === 'thread/goal/set'));
  await delay(0);
  f.client.start('one');
  const paused = await f.runtime.controlGoal('app', 'native', { action: 'pause' });
  assert.equal(paused?.status, 'paused');
  assert.equal(f.client.closed, false);
  assert.ok(!f.client.calls.some((call) => call.method === 'turn/interrupt'));
  f.client.finish('one');
  await pending;
  assert.equal(f.client.closed, true);
  const resume = f.client.calls.find((call) => call.method === 'thread/goal/set')!;
  assert.deepEqual(resume.params, { threadId: 'native', status: 'active' });
});

test('Stop pauses the scheduler and interrupts only the tracked goal turn', async () => {
  const f = fixture();
  const pending = f.run('/goal Finish it');
  await until(() => f.client.calls.some((call) => call.method === 'thread/goal/set'));
  await delay(0);
  f.client.start('one');
  assert.equal(await f.runtime.abort('app'), true);
  await pending;
  const controls = f.client.calls.filter((call) => call.method === 'thread/goal/set' || call.method === 'turn/interrupt');
  assert.equal(controls.at(-2)?.params.status, 'paused');
  assert.deepEqual(controls.at(-1), { method: 'turn/interrupt', params: { threadId: 'native', turnId: 'one' } });
});

test('Stop between goal turns pauses without interrupting an unrelated turn', async () => {
  const f = fixture();
  const pending = f.run('/goal Finish it');
  await until(() => f.client.calls.some((call) => call.method === 'thread/goal/set'));
  await delay(0);
  f.client.start('one'); f.client.finish('one');
  await f.runtime.abort('app');
  await pending;
  assert.ok(!f.client.calls.some((call) => call.method === 'turn/interrupt'));
  assert.equal(f.client.state?.status, 'paused');
});

test('goal Stop waits for the owned process to release its writer before acknowledging completion', async () => {
  const f = fixture();
  let closeStarted = false, stopped = false;
  let release!: () => void;
  f.client.close = () => {
    closeStarted = true;
    return new Promise<void>((resolve) => { release = resolve; });
  };
  const pending = f.run('/goal Finish it');
  await until(() => f.client.calls.some((call) => call.method === 'thread/goal/set'));
  await delay(0);
  f.client.start('one');
  const aborting = f.runtime.abort('app').then(() => { stopped = true; });
  await until(() => closeStarted);
  assert.equal(stopped, false);
  assert.ok(!f.messages.some((message) => message.kind === 'complete'));
  release();
  await aborting;
  await pending;
  assert.equal(stopped, true);
});

test('Stop during native goal startup waits for cleanup and never activates the goal', async () => {
  const f = fixture();
  f.context.resolveProviderSessionId = () => null;
  let resume!: (value: AnyRecord) => void;
  let stopped = false;
  f.client.override = async (method) => method === 'thread/start'
    ? new Promise<AnyRecord>((resolve) => { resume = resolve; }) : undefined;
  const pending = f.run('/goal Finish it');
  await until(() => f.client.calls.some((call) => call.method === 'thread/start'));
  const aborting = f.runtime.abort('app').then(() => { stopped = true; });
  await delay(0);
  assert.equal(stopped, false);
  resume({ thread: { id: 'native', status: { type: 'idle' } } });
  await aborting;
  await pending;
  assert.equal(f.client.closed, true);
  assert.ok(!f.client.calls.some((call) => call.method === 'thread/goal/set' || call.method === 'turn/start'));
});

test('an old resume notification cannot complete a newly activated goal before its first turn', async () => {
  const f = fixture();
  f.client.state = goal('budgetLimited', 42);
  f.client.override = async (method, params) => {
    if (method === 'thread/settings/update') f.client.emit('thread/goal/updated', { goal: f.client.state });
    if (method === 'thread/goal/set' && params.status === 'active') {
      // Codex 0.154 may emit the resume snapshot before this reply, and the
      // activation notification only afterwards.
      return { goal: goal('active', 42) };
    }
    return undefined;
  };
  const pending = f.run('/goal resume');
  await until(() => f.client.calls.some((call) => call.method === 'thread/goal/set'));
  await delay(0);
  f.client.emit('thread/goal/updated', { goal: goal('budgetLimited', 42) });
  await delay(0);
  assert.equal(f.client.closed, false);
  f.client.state = goal('active', 42);
  f.client.emit('thread/goal/updated', { goal: f.client.state });
  f.client.start('resumed');
  f.client.state = goal('complete', 99);
  f.client.emit('thread/goal/updated', { goal: f.client.state });
  f.client.finish('resumed');
  await pending;
  assert.ok(f.messages.some((message) => message.summary?.includes('99')));
});

test('fast native goal completion is not overwritten by an older set acknowledgement', async () => {
  const f = fixture();
  f.client.override = async (method, params) => {
    if (method !== 'thread/goal/set' || params.status !== 'active') return undefined;
    f.client.emit('thread/goal/updated', { goal: goal() });
    f.client.start('fast');
    f.client.state = goal('complete', 12);
    f.client.emit('thread/goal/updated', { goal: f.client.state });
    f.client.finish('fast');
    return { goal: goal() };
  };
  await f.run('/goal Finish the task');
  assert.equal(f.messages.filter((message) => message.kind === 'complete').length, 1);
  assert.ok(f.messages.some((message) => message.summary?.includes('complete')));
});

test('a failed goal turn is paused before its connection is released, never silently continued', async () => {
  const f = fixture();
  const pending = f.run('/goal Finish the task');
  await until(() => f.client.calls.some((call) => call.method === 'thread/goal/set'));
  await delay(0);
  f.client.start('failed');
  f.client.finish('failed', 'failed');
  await pending;
  assert.equal(f.client.state?.status, 'paused');
  assert.ok(f.messages.some((message) => message.kind === 'error'));
  assert.equal(f.fallbackCalls(), 0);
});

test('an already-active persisted goal is not resumed or taken over by another command', async () => {
  for (const command of ['/goal resume', '/goal New objective', '/plan Explore it']) {
    const f = fixture();
    f.client.state = goal();
    await f.run(command);
    assert.ok(!f.client.calls.some((call) => ['thread/resume', 'thread/goal/set', 'turn/start'].includes(call.method)));
    assert.ok(f.messages.some((message) => message.content?.includes('already has an active native goal')));
  }
});

test('native Plan Mode uses built-in instructions/read-only sandbox and strips the slash prefix', async () => {
  const f = fixture();
  await f.run('/plan Design the migration');
  const request = f.client.calls.find((call) => call.method === 'turn/start')!;
  assert.equal(request.params.input[0].text, 'Design the migration');
  assert.deepEqual(request.params.collaborationMode, {
    mode: 'plan', settings: { model: 'test-model', reasoning_effort: 'high', developer_instructions: null },
  });
  assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly' });
  assert.ok(f.messages.some((message) => message.toolInput?.plan === 'A real plan'));
  assert.equal(f.fallbackCalls(), 0);
});

test('leaving Plan Mode explicitly sends default collaboration mode', async () => {
  const f = fixture();
  await f.run('Implement the approved plan', { codexPlanMode: false });
  const request = f.client.calls.find((call) => call.method === 'turn/start')!;
  assert.equal(request.params.collaborationMode.mode, 'default');
  assert.deepEqual(request.params.sandboxPolicy, { type: 'workspaceWrite' });
});

test('disabling goals does not disable native Plan/default turns, but actual goal commands still fail', async () => {
  for (const command of ['/plan Explore it', 'Continue normally', '/goal resume']) {
    const f = fixture();
    f.client.override = async (method) => {
      if (method === 'thread/goal/get') throw new AppError('goals feature is disabled', {
        code: 'CODEX_STDIO_RPC_ERROR', details: { rpcCode: -32600 },
      });
      return undefined;
    };
    await f.run(command, { codexPlanMode: false });
    assert.equal(f.messages.some((message) => message.kind === 'error'), command.startsWith('/goal'));
    assert.equal(f.client.calls.some((call) => call.method === 'turn/start'), !command.startsWith('/goal'));
    assert.equal(f.fallbackCalls(), 0);
  }
});

test('CLI-only nodes keep an explicit default-mode send on native RPC rather than ignoring it in exec', async () => {
  const f = fixture();
  let fallback = 0;
  const runtime = new CodexSharedRuntime({
    run: async () => { fallback++; }, abort: () => false,
  }, async () => null, async () => f.client);
  await runtime.run('Implement the approved plan', { sessionId: 'new', permissionMode: 'default', codexPlanMode: false },
    { isWebSocketWriter: true, send: () => {} }, { ...f.context, resolveProviderSessionId: () => null });
  assert.equal(fallback, 0);
  assert.equal(f.client.calls.find((call) => call.method === 'thread/start')?.params.historyMode, 'legacy');
  assert.equal(f.client.calls.find((call) => call.method === 'turn/start')?.params.collaborationMode.mode, 'default');
});

test('unsupported native settings never fall back to an exec prompt', async () => {
  const f = fixture();
  f.client.override = async (method) => {
    if (method === 'thread/settings/update') throw new Error('method not found');
    return undefined;
  };
  await f.run('/goal Finish it');
  assert.equal(f.fallbackCalls(), 0);
  assert.ok(!f.client.calls.some((call) => call.method === 'thread/goal/set'));
  assert.ok(f.messages.some((message) => message.kind === 'error'));
});

test('goals refuse Plan Mode, invalid budgets and attachments before opening a native connection', async () => {
  for (const [command, options] of [
    ['/goal Finish it', { permissionMode: 'plan' }],
    ['/goal --tokens 0 Finish it', {}],
    ['/goal Finish it', { files: [{ path: '/tmp/x' }] }],
  ] as const) {
    const f = fixture();
    await f.run(command, options);
    assert.equal(f.client.calls.length, 0);
    assert.equal(f.fallbackCalls(), 0);
    assert.ok(f.messages.some((message) => message.kind === 'error'));
  }
});

test('goal controls resolve app ids, reject foreign providers and never create/resume work via HTTP', async () => {
  const calls: unknown[] = [];
  const service = createCodexCommandsService({
    getSession: (id) => id === 'app'
      ? { provider: 'codex', provider_session_id: 'native' }
      : id === 'claude' ? { provider: 'claude', provider_session_id: 'other' } : null,
    controlGoal: async (...args) => { calls.push(args); return goal('paused', 99); },
  });
  const result = await service.goal('app', 'pause');
  assert.deepEqual(calls, [['app', 'native', { action: 'pause' }]]);
  assert.equal(result.goal?.tokensUsed, 99);
  assert.equal('threadId' in result.goal!, false);
  await assert.rejects(service.goal('native', ''), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(service.goal('claude', ''), { code: 'GOAL_PROVIDER_UNSUPPORTED' });
  await assert.rejects(service.goal('app', 'resume'), { code: 'GOAL_RUN_REQUIRED' });
  await assert.rejects(service.goal('app', 'New goal'), { code: 'GOAL_RUN_REQUIRED' });
  assert.equal((await service.goal(null, '')).goal, null);
  assert.equal(calls.length, 1);
});

test('Plan questions map answers by native id, skip safely, and cannot grant a permission', () => {
  const permissions = new CodexStdioPermissions();
  const replies: AnyRecord[] = [], messages: AnyRecord[] = [];
  const client = {
    ownsProcess: true, respondToServerRequest: (id: unknown, reply: unknown) => replies.push({ id, reply }),
  } as unknown as ICodexRpcClient;
  const writer = { isWebSocketWriter: true, send: (value: unknown) => messages.push(value as AnyRecord) };
  const params = { threadId: 'native', questions: [
    { id: 'choice', question: 'Which approach?', header: 'Approach', options: null, isOther: true, isSecret: false },
  ] };
  try {
    permissions.handle(client, 'app', 'native', 'item/tool/requestUserInput', params, 1, writer);
    const id = messages.at(-1)!.requestId;
    assert.equal(messages.at(-1)!.toolName, 'AskUserQuestion');
    assert.deepEqual(messages.at(-1)!.input.questions[0].options, []);
    assert.throws(() => permissions.gateway.resolve(id, {
      allow: true, updatedInput: { answers: { foreign: 'No' } },
    }), { code: 'CODEX_QUESTION_ANSWERS_INVALID' });
    permissions.gateway.resolve(id, { allow: true, updatedInput: { answers: { choice: 'Small migration' } } });
    assert.deepEqual(replies[0].reply.result, { answers: { choice: { answers: ['Small migration'] } } });
    permissions.gateway.resolve(id, { allow: true });
    assert.equal(replies.length, 1);
    permissions.handle(client, 'app', 'native', 'item/tool/requestUserInput', params, 2, writer);
    permissions.gateway.resolve(messages.at(-1)!.requestId, { allow: false });
    assert.deepEqual(replies[1].reply.result, { answers: {} });
    permissions.handle(client, 'app', 'native', 'item/tool/requestUserInput', params, 3, writer);
    permissions.resolvedByNative(client, 3);
    assert.equal(permissions.gateway.listPending('app').length, 0);
  } finally {
    permissions.cancel('app', client);
  }
});
