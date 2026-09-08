import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';

import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// A protocol-level fake: no real Codex process, home, database or gateway is touched.
async function fixture(
  t: TestContext,
  body: (f: {
    runtime: CodexSharedRuntime;
    requests: Array<{ method: string; params: AnyRecord }>;
    messages: AnyRecord[];
    emit: (method: string, params: AnyRecord) => void;
    rejectSteer: (error: Error) => void;
  }) => Promise<void>,
) {
  const requests: Array<{ method: string; params: AnyRecord }> = [];
  const messages: AnyRecord[] = [];
  const listeners = new Set<(method: string, params: AnyRecord) => void>();
  let steerError: Error | null = null;
  const emit = (method: string, params: AnyRecord) => {
    for (const listener of listeners) listener(method, { threadId: 'native-thread', turnId: 'owned-turn', ...params });
  };
  const client = {
    request: async (method: string, params: AnyRecord) => {
      requests.push({ method, params });
      if (method === 'thread/resume') return { thread: { id: 'native-thread', status: { type: 'idle' } } };
      if (method === 'turn/start') return { turn: { id: 'owned-turn' } };
      if (method === 'turn/steer') {
        if (steerError) throw steerError;
        return { turnId: params.expectedTurnId };
      }
      return {};
    },
    onNotification: (listener: (method: string, params: AnyRecord) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDisconnect: () => () => {},
    onServerRequest: () => () => {},
    close: () => {},
  };
  t.mock.method(CodexDaemonClient, 'connect', async () => client as unknown as CodexDaemonClient);
  const runtime = new CodexSharedRuntime({
    run: async () => { assert.fail('Steering must never use the exec fallback'); },
    abort: () => { assert.fail('Steering must never abort the exec fallback'); },
  });
  const provider = new CodexSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'native-thread',
    resolveResumeModel: async () => 'original-model',
    getProviderModels: async () => ({ DEFAULT: 'original-model', OPTIONS: [] }),
    normalizeMessage: (raw, sessionId) => provider.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const running = runtime.run('Original task', { sessionId: 'app-session', cwd: process.cwd() }, {
    isWebSocketWriter: true, send: (message) => messages.push(message as AnyRecord),
  }, context);
  await nextTick();
  assert.equal(runtime.canSteer('app-session'), true);
  try {
    await body({ runtime, requests, messages, emit, rejectSteer: (error) => { steerError = error; } });
  } finally {
    // Interrupted completion avoids sending completion notifications in this isolated test.
    emit('turn/completed', { turn: { id: 'owned-turn', status: 'interrupted' } });
    await running;
  }
}

test('steering uses the owned turn, keeps streaming, and never changes model/permissions or restarts', async (t) => {
  await fixture(t, async ({ runtime, requests, messages, emit }) => {
    assert.ok(messages.some((message) => message.kind === 'status' && message.canSteer === true));
    await runtime.steer('app-session', 'Focus on correctness, not styling.', {
      model: 'different-model', effort: 'low', permissionMode: 'bypassPermissions',
      cwd: 'untrusted-path', threadId: 'another-thread', expectedTurnId: 'another-turn',
    });
    const corrections = requests.filter((request) => request.method === 'turn/steer');
    assert.deepEqual(corrections, [{
      method: 'turn/steer',
      params: {
        threadId: 'native-thread', expectedTurnId: 'owned-turn',
        input: [{ type: 'text', text: 'Focus on correctness, not styling.' }],
      },
    }]);
    assert.equal(runtime.canSteer('app-session'), true);
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.equal(requests.some((request) => request.method === 'turn/interrupt'), false);
    assert.equal(messages.some((message) => message.kind === 'complete'), false);
    emit('item/completed', { item: { id: 'reply', type: 'agentMessage', text: 'Updated direction' } });
    assert.ok(messages.some((message) => message.content === 'Updated direction'));
  });
});

test('steering encodes uploaded images and file references with native input types', async (t) => {
  await fixture(t, async ({ runtime, requests }) => {
    const image = path.join(getGlobalImageAssetsDir(), 'steer.png');
    const file = path.join(getGlobalImageAssetsDir(), 'requirements.txt');
    await runtime.steer('app-session', 'Use these requirements', {
      images: [{ path: image, name: 'steer.png' }],
      files: [{ path: file, name: 'requirements.txt' }],
    });
    const input = requests.find((request) => request.method === 'turn/steer')!.params.input;
    assert.match(input[0].text, /Use these requirements[\s\S]*<files_input>/);
    assert.ok(input[0].text.includes(file.replaceAll('\\', '/')));
    assert.deepEqual(input[1], { type: 'localImage', path: image });
  });
});

test('an ended or unowned session cannot steer another active turn', async (t) => {
  await fixture(t, async ({ runtime, requests, emit }) => {
    await assert.rejects(runtime.steer('other-session', 'Do not cross sessions', {}), { code: 'STEER_UNAVAILABLE' });
    emit('turn/completed', { turn: { id: 'owned-turn', status: 'interrupted' } });
    assert.equal(runtime.canSteer('app-session'), false);
    await assert.rejects(runtime.steer('app-session', 'Late correction', {}), { code: 'STEER_UNAVAILABLE' });
    assert.equal(requests.some((request) => request.method === 'turn/steer'), false);
  });
});

test('an RPC refusal does not end the run or retry the correction', async (t) => {
  await fixture(t, async ({ runtime, requests, messages, rejectSteer }) => {
    rejectSteer(new Error('expectedTurnId does not match the active turn'));
    await assert.rejects(runtime.steer('app-session', 'Correction', {}), /expectedTurnId/);
    assert.equal(runtime.canSteer('app-session'), true);
    assert.equal(requests.filter((request) => request.method === 'turn/steer').length, 1);
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
    assert.equal(messages.some((message) => message.kind === 'complete' || message.kind === 'error'), false);
  });
});

test('legacy exec runs do not advertise steering or start a second process', async (t) => {
  t.mock.method(CodexDaemonClient, 'connect', async () => null);
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  let starts = 0;
  const runtime = new CodexSharedRuntime({ run: async () => { starts += 1; await wait; }, abort: () => false });
  const running = runtime.run('task', { sessionId: 'legacy' }, { send() {} }, {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ DEFAULT: 'model', OPTIONS: [] }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  });
  await nextTick();
  try {
    assert.equal(runtime.canSteer('legacy'), false);
    await assert.rejects(runtime.steer('legacy', 'correction', {}), { code: 'STEER_UNAVAILABLE' });
    assert.equal(starts, 1);
  } finally {
    finish();
    await running;
  }
});
