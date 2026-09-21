import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime, LLMProvider, NewCodexSessionTitleRequest, ProviderRuntimeWriter } from '@/shared/index.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(
  providers: IProvider[],
  overrides: NonNullable<Parameters<typeof createProviderRuntimeService>[0]> = {},
) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
    ...overrides,
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('new native and SDK creation notifications schedule one title after the original writer records the mapping', async () => {
  for (const channel of ['setSessionId', 'event', 'json-event'] as const) {
    const order: string[] = [];
    const titles: NewCodexSessionTitleRequest[] = [];
    let resolveTitle!: () => void;
    const titleWork = new Promise<void>(resolve => { resolveTitle = resolve; });
    const event = { kind: 'session_created', newSessionId: 'new-native' };
    const runtime = createRuntime({
      async run(_command, _options, writer) {
        if (channel === 'setSessionId') writer.setSessionId?.('new-native');
        const message = channel === 'json-event' ? JSON.stringify(event) : event;
        writer.send(message);
        writer.send(message);
        writer.send('non-JSON progress');
        writer.send({ kind: 'complete', success: true });
        return 'done';
      },
    });
    const service = createService([createProvider('codex', runtime)], {
      resolveProviderSessionId: () => null,
      scheduleTitle: input => {
        order.push('title');
        titles.push(input);
        return titleWork;
      },
    });
    const result = await service.run('codex', 'Investigate the disconnected Mac node', {
      sessionId: 'app', images: [{ path: '/private/image.png' }],
    }, {
      setSessionId: () => { order.push('mapping'); },
      send: () => { order.push('send'); },
    });
    assert.equal(result, 'done', 'chat completion must not await title generation');
    assert.equal(order[0], channel === 'setSessionId' ? 'mapping' : 'send');
    assert.equal(order[1], 'title');
    assert.deepEqual(titles, [{
      sessionId: 'app', providerSessionId: 'new-native',
      initialMessage: 'Investigate the disconnected Mac node',
    }]);
    resolveTitle();
  }
});

test('resumes, direct calls without an app ID, and other providers never schedule Codex titles', async () => {
  for (const scenario of ['resume', 'no-app-id', 'claude'] as const) {
    const provider = scenario === 'claude' ? 'claude' : 'codex';
    let titles = 0;
    const writer: ProviderRuntimeWriter = { send() {}, setSessionId() {} };
    const runtime = createRuntime({
      async run(_command, _options, output) {
        assert.equal(output, writer);
        output.setSessionId?.('native');
        output.send({ kind: 'session_created', newSessionId: 'native' });
      },
    });
    const service = createService([createProvider(provider, runtime)], {
      resolveProviderSessionId: () => scenario === 'resume' ? 'existing' : null,
      scheduleTitle: async () => { titles++; },
    });
    await service.run(provider, 'Continue', scenario === 'no-app-id' ? {} : { sessionId: 'app' }, writer);
    assert.equal(titles, 0);
  }
});

test('title scheduler exceptions cannot turn a successful user conversation into an error', async () => {
  for (const asynchronous of [false, true]) {
    const runtime = createRuntime({
      async run(_command, _options, writer) {
        writer.setSessionId?.('native');
        return 'user turn completed';
      },
    });
    const service = createService([createProvider('codex', runtime)], {
      resolveProviderSessionId: () => null,
      scheduleTitle: () => {
        if (asynchronous) return Promise.reject(new Error('title failed'));
        throw new Error('title failed');
      },
    });
    assert.equal(await service.run('codex', 'User task', { sessionId: 'app' }, { send() {} }), 'user turn completed');
  }
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('steering dispatches only through the provider-owned capability and never run/abort', async () => {
  const calls: unknown[][] = [];
  const service = createService([
    createProvider('codex', createRuntime({
      canSteer: (sessionId) => sessionId === 'owned-session',
      steer: async (...args) => { calls.push(args); },
      run: async () => { assert.fail('steer must not run'); },
      abort: () => { assert.fail('steer must not abort'); },
    })),
    createProvider('claude', createRuntime()),
  ]);
  assert.equal(service.canSteer('codex', 'owned-session'), true);
  assert.equal(service.canSteer('codex', 'other-session'), false);
  assert.equal(service.canSteer('claude', 'owned-session'), false);
  await service.steer('codex', 'owned-session', 'new direction', { images: [] });
  assert.deepEqual(calls, [['owned-session', 'new direction', { images: [] }]]);
  await assert.rejects(service.steer('claude', 'owned-session', 'new direction', {}), { code: 'STEER_UNSUPPORTED' });
});
