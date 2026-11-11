import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createAntigravityRuntime } from '@/modules/providers/list/antigravity/antigravity-runtime.provider.js';
import { AntigravityProviderModels } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import { AntigravitySessionsProvider, antigravitySessionStore } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/index.js';

const loader = createRequire(import.meta.url).resolve('tsx');
const fixture = fileURLToPath(new URL('./fixtures/fake-antigravity-bridge.ts', import.meta.url));

async function setup(mode: string, run: (fixture: {
  runtime: ReturnType<typeof createAntigravityRuntime>;
  context: ProviderRuntimeContext;
  root: string;
  cwd: string;
  capture: string;
  events: NormalizedMessage[];
  writer: { send(event: unknown): void; setSessionId(id: string): void };
}) => Promise<void>) {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), 'antigravity-runtime-'));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  process.env.CODEY_ANTIGRAVITY_HOME = path.join(root, 'google');
  process.env.CODEY_ANTIGRAVITY_CONFIG = path.join(root, 'config.json');
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  delete process.env.GEMINI_API_KEY;
  await writeFile(process.env.CODEY_ANTIGRAVITY_CONFIG, '{"apiKey":"test-credential"}');
  if (mode === 'managed') {
    process.env.CODEY_MODEL_API_KEY = 'private-managed-proxy-key';
    process.env.GEMINI_API_KEY = 'unused-private-google-key';
    await writeFile(process.env.CODEY_ANTIGRAVITY_CONFIG, 'invalid direct Google config');
  }
  closeConnection();
  await initializeDatabase();
  sessionsDb.createAppSession('app-google', 'antigravity', cwd, 'Test');
  const capture = path.join(root, 'request.json');
  const runtime = createAntigravityRuntime({
    ...(mode === 'managed' ? { gateway: {
      isManaged: () => true,
      getModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
      open: async () => ({ credentials: { apiKey: 'per-turn-token', baseUrl: 'http://127.0.0.1:12345', vertex: false }, close: async () => {} }),
    } } : {}),
    createBridge: (workspace, environment) => spawn(process.execPath, ['--import', loader, fixture], {
      cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...environment, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
        FAKE_ANTIGRAVITY_MODE: mode, FAKE_ANTIGRAVITY_CAPTURE: capture },
    }),
    startupTimeoutMs: mode === 'startup-hang' ? 100 : 5_000,
    approvalTimeoutMs: mode === 'timeout' ? 20 : 2_000,
  });
  let nativeId: string | null = null;
  const events: NormalizedMessage[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async (_id, requested) => requested ?? undefined,
    getProviderModels: () => new AntigravityProviderModels().getSupportedModels(),
    isProviderInstalled: async () => true,
    normalizeMessage: () => [],
  };
  try {
    await run({ runtime, root, cwd, capture, events, context, writer: {
      send: event => { events.push(event as NormalizedMessage); },
      setSessionId: id => {
        nativeId = id;
        sessionsDb.assignProviderSessionId('app-google', id);
      },
    } });
  } finally {
    await runtime.abort('app-google');
    closeConnection();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}

test('managed SDK receives only its per-turn credential, not Google or node proxy secrets', async () => {
  await setup('managed', async ({ runtime, context, cwd, capture, writer }) => {
    await runtime.run('Through Copilot', { sessionId: 'app-google', cwd, model: 'gemini-4-carbon' }, writer, context);
    const body = await readFile(capture, 'utf8');
    assert.equal(JSON.parse(body).credentials.apiKey, 'per-turn-token');
    assert.equal(JSON.parse(body).managed, true);
    assert.doesNotMatch(body, /private-managed-proxy-key|unused-private-google-key/);
  });
});

test('Google runtime passes the selected model/effort to SDK and persists resumable history', async () => {
  await setup('text', async ({ runtime, context, cwd, capture, events, writer }) => {
    await runtime.run('First prompt', { sessionId: 'app-google', cwd, model: 'gemini-4-argon', effort: 'medium' }, writer, context);
    const request = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(request.model, 'gemini-4-argon');
    assert.equal(request.effort, 'medium');
    assert.equal(request.resume, false);
    assert.equal(sessionsDb.getSessionByProviderSessionId(request.conversationId)?.session_id, 'app-google');
    assert.equal(events.filter(event => event.kind === 'complete').length, 1);
    assert.equal(events.find(event => event.kind === 'complete')?.success, true);
    assert.equal(events.filter(event => event.kind === 'stream_delta').map(event => event.content).join(''), 'Google response');
    const history = await new AntigravitySessionsProvider().fetchHistory(request.conversationId, { limit: null });
    assert.deepEqual(history.messages.map(message => message.content), ['First prompt', 'Google response']);
    await runtime.run('Second prompt', { sessionId: 'app-google', cwd, model: 'gemini-4-carbon', effort: 'default' }, writer, context);
    const resumed = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(resumed.conversationId, request.conversationId);
    assert.equal(resumed.resume, true);
    assert.equal(resumed.model, 'gemini-4-carbon');
    assert.equal(resumed.effort, undefined);
    const page = await new AntigravitySessionsProvider().fetchHistory(request.conversationId, { limit: 2 });
    assert.deepEqual(page.messages.map(message => message.content), ['Second prompt', 'Google response']);
    assert.equal(page.hasMore, true);
    const nativeState = path.join(antigravitySessionStore.directory(request.conversationId), 'sdk');
    await mkdir(nativeState, { recursive: true });
    await writeFile(path.join(nativeState, 'trajectory.bin'), 'private native history');
    const deleted = await sessionsService.deleteOrArchiveSessionById('app-google', { force: true, deletedFromDisk: true });
    assert.equal(deleted.deletedFromDisk, true);
    await assert.rejects(() => readFile(path.join(nativeState, 'trajectory.bin')), { code: 'ENOENT' });
    assert.equal(await new AntigravitySessionsProvider().deletePersistedSession(request.conversationId), false);
  });
});

for (const allow of [false, true]) {
  test(`Google SDK tool permission ${allow ? 'approval' : 'denial'} reaches the child`, async () => {
    await setup('permission', async ({ runtime, context, cwd, events, writer }) => {
      const sending = runtime.run('Run tool', { sessionId: 'app-google', cwd }, {
        ...writer,
        send(event) {
          writer.send(event);
          const value = event as NormalizedMessage;
          if (value.kind === 'permission_request') {
            assert.equal(runtime.permissions?.listPending('app-google').length, 1);
            assert.deepEqual(value.context, { canRemember: false });
            runtime.permissions?.resolve(value.requestId!, { allow });
          }
        },
      }, context);
      await sending;
      assert.equal(runtime.permissions?.listPending('app-google').length, 0);
      assert.equal(events.find(event => event.kind === 'tool_result')?.isError, !allow);
      assert.equal(typeof events.find(event => event.kind === 'tool_result')?.content, 'string');
      assert.equal(events.filter(event => event.kind === 'tool_use').length, 1);
      assert.equal(events.find(event => event.kind === 'tool_use')?.toolId, 'copilot-call-id');
      assert.equal(events.find(event => event.kind === 'tool_result')?.toolId, 'copilot-call-id');
    });
  });
}

test('Google SDK questions reuse the existing AskUserQuestion payload', async () => {
  await setup('question', async ({ runtime, context, cwd, writer }) => {
    await runtime.run('Ask', { sessionId: 'app-google', cwd }, {
      ...writer,
      send(event) {
        writer.send(event);
        const value = event as NormalizedMessage;
        if (value.kind === 'permission_request') {
          const input = value.input as AnyRecord;
          assert.equal(input.questions[0].options[0].label, 'First');
          runtime.permissions?.resolve(value.requestId!, { allow: true, updatedInput: { answers: { 'Choose a name': 'First' } } });
        }
      },
    }, context);
  });
});

test('Google stop closes its owned SDK process and preserves partial output without duplicate completion', async () => {
  await setup('hold', async ({ runtime, context, cwd, events, writer }) => {
    let stopping: Promise<boolean> | undefined;
    await runtime.run('Wait', { sessionId: 'app-google', cwd }, {
      ...writer,
      send(event) {
        writer.send(event);
        if ((event as NormalizedMessage).kind === 'stream_delta') {
          stopping = Promise.resolve(runtime.abort('app-google'));
        }
      },
    }, context);
    assert.equal(await stopping, true);
    assert.equal(events.filter(event => event.kind === 'complete').length, 0);
    const nativeId = context.resolveProviderSessionId('app-google')!;
    const messages = await antigravitySessionStore.messages(nativeId);
    assert.equal(messages.at(-1)?.content, 'Google response');
    assert.equal(runtime.canInterrupt?.('app-google'), false);
  });
});

for (const mode of ['error', 'malformed', 'startup-hang', 'cancelled']) {
  test(`Google ${mode} settles with exactly one failed completion`, async () => {
    await setup(mode, async ({ runtime, context, cwd, events, writer }) => {
      await assert.rejects(() => runtime.run('Fail', { sessionId: 'app-google', cwd }, writer, context));
      const completions = events.filter(event => event.kind === 'complete');
      assert.equal(completions.length, 1);
      assert.equal(completions[0].success, false);
    });
  });
}

test('missing Google credentials fail before launching an SDK process', async () => {
  await setup('text', async ({ runtime, context, cwd, events, writer }) => {
    await writeFile(process.env.CODEY_ANTIGRAVITY_CONFIG!, '{}');
    await assert.rejects(() => runtime.run('Do not run', { sessionId: 'app-google', cwd }, writer, context), /credentials/);
    assert.equal(events.some(event => event.kind === 'session_created'), false);
  });
});

test('Google attachments cannot expose files outside the workspace/upload roots', async () => {
  await setup('text', async ({ runtime, context, cwd, root, events, writer }) => {
    const secret = path.join(root, 'outside.txt');
    await writeFile(secret, 'must not reach the model');
    await assert.rejects(() => runtime.run('Read attachment', {
      sessionId: 'app-google', cwd, files: [{ path: secret }],
    }, writer, context), /attachments must be/);
    assert.equal(events.some(event => event.kind === 'session_created'), false);
  });
});
