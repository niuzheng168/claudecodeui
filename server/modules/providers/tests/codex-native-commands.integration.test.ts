import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

// Opt-in: runs a real installed Codex against an offline localhost model fixture,
// never real credentials/model APIs, workspaces, or sessions.
const native = { skip: process.env.CODEY_TEST_NATIVE_COMMANDS !== '1', concurrency: false };

async function fixture(
  mode: 'goal' | 'plan',
  runTest: (value: {
    runtime: CodexSharedRuntime; requests: AnyRecord[]; messages: AnyRecord[];
    run(command: string): Promise<void>; threadId(): string | null;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codey-native-command-'));
  const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  const requests: AnyRecord[] = [], messages: AnyRecord[] = [];
  const clients: CodexStdioClient[] = [];
  let threadId: string | null = null;
  const workspace = path.join(root, 'workspace');
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    if (!text) { response.end('{}'); return; }
    requests.push(JSON.parse(text));
    const n = requests.length;
    const item = mode === 'plan' && n === 1
      ? {
        id: 'question-item', type: 'function_call', name: 'request_user_input', call_id: 'question-call',
        arguments: JSON.stringify({ questions: [{
          id: 'approach', header: 'Approach', question: 'Which migration?',
          options: [{ label: 'Small', description: 'A small change' }, { label: 'Large', description: 'A broad change' }],
        }] }),
      }
      : {
        id: `answer-${n}`, type: 'message', role: 'assistant', phase: 'final', status: 'completed',
        content: [{ type: 'output_text', text: mode === 'plan'
          ? '<proposed_plan>\n# Offline plan\n\nUse a small migration and test it.\n</proposed_plan>'
          : `Offline step ${n} finished.`, annotations: [] }],
      };
    const result = {
      id: `response-${n}`, object: 'response', status: 'completed', model: 'fixture-model',
      output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    await mkdir(workspace);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    await writeFile(path.join(root, 'config.toml'), `
model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Offline fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[features]
goals = ${mode === 'goal'}
[analytics]
enabled = false
`);
    process.env.HOME = root;
    process.env.CODEX_HOME = root;
    const executable = process.env.CODEY_TEST_CODEX_EXECUTABLE || process.execPath;
    const launcherArgs = process.env.CODEY_TEST_CODEX_EXECUTABLE ? []
      : [createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')];
    const runtime = new CodexSharedRuntime({
      run: async () => assert.fail('Native commands must not use exec fallback'), abort: () => false,
    }, async () => null, async () => {
      const client = await CodexStdioClient.connect({ executable, launcherArgs, home: root });
      if (process.env.CODEY_TEST_TRACE_NATIVE === '1') {
        const request = client.request.bind(client);
        client.request = async (method, params) => {
          console.log('RPC', method, JSON.stringify(params));
          const result = await request(method, params);
          console.log('REPLY', method, JSON.stringify(result.goal ?? result.thread?.status ?? {}));
          return result;
        };
        client.onNotification((method, params) => {
          if (/thread\/goal|turn\/started|turn\/completed/.test(method)) {
            console.log('EVENT', method, JSON.stringify(params.goal ?? params.turn?.status));
          }
        });
      }
      clients.push(client);
      return client;
    });
    const provider = new CodexSessionsProvider();
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => threadId,
      resolveResumeModel: async () => 'fixture-model',
      getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [{ value: 'fixture-model', label: 'Offline fixture' }] }),
      normalizeMessage: (raw, id) => provider.normalizeMessage(raw, id),
      isProviderInstalled: async () => true,
    };
    const run = async (command: string) => {
      let timeout: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          runtime.run(command, { sessionId: 'app', cwd: workspace, permissionMode: 'default' }, {
            isWebSocketWriter: true,
            setSessionId: (id) => { threadId = id; },
            send: (value) => {
              const message = value as AnyRecord;
              messages.push(message);
              if (message.kind === 'permission_request' && message.toolName === 'AskUserQuestion') {
                runtime.permissions.resolve(message.requestId, {
                  allow: true, updatedInput: { answers: { approach: 'Small' } },
                });
              }
            },
          }, context),
          new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error('Native fixture timed out')), 20_000); }),
        ]);
      } finally { clearTimeout(timeout!); }
    };
    await runTest({ runtime, requests, messages, run, threadId: () => threadId });
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of ['HOME', 'CODEX_HOME'] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('real Codex goal auto-runs, reaches its budget, and reads/updates/resumes persisted usage', native, async () => {
  await fixture('goal', async ({ runtime, messages, requests, run, threadId }) => {
    await run('/goal --tokens 20 Complete the offline fixture without tools.');
    assert.ok(threadId());
    assert.deepEqual(messages.filter((message) => message.kind === 'error'), []);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(requests.length >= 2, 'Native goal should continue beyond one model response');
    const saved = await runtime.controlGoal('app', threadId()!, { action: 'get' });
    assert.equal(saved?.status, 'budgetLimited');
    assert.ok(saved!.tokensUsed >= 20);
    const used = saved!.tokensUsed;
    const updated = await runtime.controlGoal('app', threadId()!, { action: 'budget', tokenBudget: used + 20 });
    assert.equal(updated?.tokensUsed, used, 'Changing a budget must not reset usage');
    await run('/goal resume');
    assert.deepEqual(messages.filter((message) => message.kind === 'error'), []);
    const resumed = await runtime.controlGoal('app', threadId()!, { action: 'get' });
    assert.equal(resumed?.status, 'budgetLimited');
    assert.ok(resumed!.tokensUsed > used);
  });
});

test('real Codex Plan Mode uses built-in instructions and completes a native question round-trip', native, async () => {
  await fixture('plan', async ({ messages, requests, run }) => {
    await run('/plan Plan an offline migration; ask the fixture question before proposing the plan.');
    assert.deepEqual(messages.filter((message) => message.kind === 'error'), []);
    assert.ok(messages.some((message) => message.kind === 'permission_request' && message.toolName === 'AskUserQuestion'));
    assert.ok(messages.some((message) => message.kind === 'permission_resolved'));
    assert.ok(requests.length >= 2);
    assert.match(JSON.stringify(requests[0]), /Plan Mode/);
    assert.match(JSON.stringify(requests[1]), /Small/);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.find((message) => message.kind === 'complete')?.exitCode, 0);
    // Planning must also resume independently when the separate goals feature
    // is disabled in the user's config.
    await run('/plan Refine the existing offline plan without asking another question.');
    assert.deepEqual(messages.filter((message) => message.kind === 'error'), []);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 2);
  });
});
