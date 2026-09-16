import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { projectCodexDaemonItem } from '@/modules/providers/list/codex/codex-daemon-items.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

// Opt-in, like the native goal/plan fixtures: an isolated real Codex process
// and a localhost model stub, never a user's daemon, credentials or sessions.
for (const historyMode of ['paginated', 'legacy'] as const) {
  test(`real shared Codex accepts Codey corrections in a desktop-started ${historyMode} turn`, {
    skip: process.env.CODEY_TEST_NATIVE_COMMANDS !== '1' || process.platform === 'win32',
    timeout: 45_000,
  }, () => runDesktopSteeringFixture(historyMode));
  test(`real shared Codex can be observed and explicitly stopped from another client (${historyMode})`, {
    skip: process.env.CODEY_TEST_NATIVE_COMMANDS !== '1' || process.platform === 'win32',
    timeout: 45_000,
  }, () => runDesktopSteeringFixture(historyMode, true));
}

async function runDesktopSteeringFixture(historyMode: 'paginated' | 'legacy', observeAndStop = false): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codey-desktop-steer-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  const socketPath = path.join(root, 'owner.sock');
  const messages: AnyRecord[] = [], modelRequests: AnyRecord[] = [], rpc: AnyRecord[] = [];
  const pendingResponses: Array<() => void> = [];
  const clients: CodexDaemonClient[] = [];
  let released = false;
  let running: Promise<void> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  let logs = '';
  const model = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (!body) { response.end('{}'); return; }
    modelRequests.push(JSON.parse(body));
    const n = modelRequests.length;
    const finish = () => {
      if (response.destroyed) return;
      const item = {
        id: `reply-${n}`, type: 'message', role: 'assistant', phase: 'final', status: 'completed',
        content: [{ type: 'output_text', text: `Offline response ${n}`, annotations: [] }],
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
    };
    if (released) finish();
    else pendingResponses.push(finish);
  });
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 1_000; i++) {
      if (condition()) return;
      await delay(10);
    }
    assert.fail(`Native steering fixture timed out.\n${JSON.stringify(messages)}\n${logs}`);
  };
  try {
    await mkdir(home);
    await mkdir(workspace);
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const { port } = model.address() as { port: number };
    await writeFile(path.join(home, 'config.toml'), `
model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Offline fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
`);
    const executable = process.env.CODEY_TEST_CODEX_EXECUTABLE || process.execPath;
    const launcher = process.env.CODEY_TEST_CODEX_EXECUTABLE ? []
      : [createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')];
    child = spawn(executable, [...launcher, 'app-server', '--listen', `unix://${socketPath}`], {
      cwd: home, detached: true,
      // Do not inherit provider credentials, runtime transports or parent-thread identity.
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume();
    child.stderr?.on('data', (data) => { logs = (logs + data).slice(-12_000); });
    let childError: Error | undefined;
    child.on('error', (error) => { childError = error; });
    exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    let owner: CodexDaemonClient | null = null;
    for (let i = 0; i < 200 && !owner; i++) {
      if (childError) throw childError;
      if (child.exitCode != null) throw new Error(`Isolated Codex exited: ${logs}`);
      try { owner = await CodexDaemonClient.connect({ socketPath, timeoutMs: 2_000 }); }
      catch { await delay(20); }
    }
    assert.ok(owner, `Isolated Codex did not open its socket: ${logs}`);
    clients.push(owner);
    const created = await owner.request('thread/start', {
      cwd: workspace, model: 'fixture-model', approvalPolicy: 'never',
      sandbox: 'read-only', historyMode,
    });
    const threadId = created.thread.id;
    const startedTurns: string[] = [];
    const completedTurns: string[] = [];
    owner.onNotification((method, params) => {
      if (params.threadId !== threadId) return;
      if (method === 'turn/started') startedTurns.push(params.turn.id);
      if (method === 'turn/completed') completedTurns.push(params.turn.id);
    });
    const started = await owner.request('turn/start', {
      threadId, input: [{ type: 'text', text: 'Original desktop task' }],
    });
    const turnId = started.turn.id;
    await until(() => modelRequests.length > 0);
    const runtime = new CodexSharedRuntime({
      run: async () => assert.fail('Desktop steering must never use exec'), abort: () => false,
    }, async () => {
      const client = await CodexDaemonClient.connect({ socketPath });
      assert.ok(client);
      clients.push(client);
      const request = client.request.bind(client);
      client.request = (method, params) => {
        rpc.push({ method, params });
        return request(method, params);
      };
      return client;
    });
    const provider = new CodexSessionsProvider();
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => threadId,
      resolveResumeModel: async () => 'fixture-model',
      getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [] }),
      normalizeMessage: (raw, id) => provider.normalizeMessage(raw, id),
      isProviderInstalled: async () => true,
    };
    let finished = false;
    if (observeAndStop) {
      const observation = await runtime.prepareObservation('app', context);
      assert.ok(observation);
      running = observation.start({ isWebSocketWriter: true, send: (value) => messages.push(value as AnyRecord) })
        .finally(() => { finished = true; });
      await until(() => runtime.canSteer('app') || finished);
      assert.equal(runtime.canSteer('app'), true, JSON.stringify(messages));
      assert.equal(runtime.canInterrupt('app'), true);
      assert.ok(!rpc.some((request) => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(request.method)));
      await assert.rejects(runtime.abort('app'), { code: 'CODEX_DESKTOP_TURN_NOT_OWNED' });
      assert.equal(await runtime.abort('app', { allowExternalTurn: true }), true);
      await until(() => finished && completedTurns.includes(turnId));
      await running;
      assert.deepEqual(startedTurns, [turnId]);
      assert.deepEqual(completedTurns, [turnId]);
      assert.deepEqual(rpc.filter((request) => request.method === 'turn/interrupt').map((request) => request.params),
        [{ threadId, turnId }]);
      const page = await owner.request('thread/turns/list', {
        threadId, limit: 10, sortDirection: 'desc', itemsView: 'full',
      });
      assert.equal(page.data.length, 1);
      assert.equal(page.data[0].id, turnId);
      assert.equal(page.data[0].status, 'interrupted');
      assert.ok(page.data[0].completedAt);
      assert.deepEqual(messages.filter((message) => message.kind === 'error'), []);
      return;
    }
    running = runtime.run('Codey correction: focus on tests', {
      sessionId: 'app', cwd: workspace, permissionMode: 'bypassPermissions', clientMessageId: 'codey-input-first',
    }, { isWebSocketWriter: true, send: (value) => messages.push(value as AnyRecord) }, context)
      .finally(() => { finished = true; });
    await until(() => runtime.canSteer('app') || finished);
    assert.equal(runtime.canSteer('app'), true, JSON.stringify(messages));
    assert.ok(messages.some((message) => message.canSteer === true && message.canInterrupt === true));
    await assert.rejects(runtime.abort('app'), { code: 'CODEX_DESKTOP_TURN_NOT_OWNED' });
    assert.equal(completedTurns.length, 0);
    await runtime.steer('app', 'Codey follow-up: check edge cases', { clientMessageId: 'codey-input-second' });
    await runtime.steer('app', 'Codey correction: focus on tests', { clientMessageId: 'codey-input-repeat' });
    released = true;
    for (const finish of pendingResponses) finish();
    await until(() => finished);
    await running;
    assert.deepEqual(messages.filter((message) => message.kind === 'error'), []);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(messages.at(-1)?.success, true);
    // Delivery to the two independent sockets is not ordered across clients.
    await until(() => completedTurns.includes(turnId));
    assert.deepEqual(startedTurns, [turnId]);
    assert.deepEqual(completedTurns, [turnId]);
    assert.ok(!rpc.some((request) => [
      'turn/start', 'turn/interrupt', 'thread/start', 'thread/fork', 'thread/settings/update',
    ].includes(request.method)));
    assert.deepEqual(rpc.filter((request) => request.method === 'turn/steer').map((request) => ({
      ...request.params, input: request.params.input[0].text,
    })), [
      { threadId, expectedTurnId: turnId, input: 'Codey correction: focus on tests', clientUserMessageId: 'codey-input-first' },
      { threadId, expectedTurnId: turnId, input: 'Codey follow-up: check edge cases', clientUserMessageId: 'codey-input-second' },
      { threadId, expectedTurnId: turnId, input: 'Codey correction: focus on tests', clientUserMessageId: 'codey-input-repeat' },
    ]);
    const history = await owner.request('thread/turns/list', {
      threadId, limit: 10, sortDirection: 'desc', itemsView: 'full',
    });
    assert.deepEqual(history.data.map((turn: AnyRecord) => turn.id), [turnId]);
    assert.match(JSON.stringify(history.data), /Codey correction: focus on tests/);
    assert.match(JSON.stringify(history.data), /Codey follow-up: check edge cases/);
    assert.match(JSON.stringify(modelRequests), /Codey correction: focus on tests/);
    assert.match(JSON.stringify(modelRequests), /Codey follow-up: check edge cases/);
    const inputs = history.data[0].items.filter((item: AnyRecord) => item.type === 'userMessage' && item.clientId);
    for (const message of messages.filter((message) => message.nativePosition)) {
      assert.equal(message.nativePosition.turnId, turnId);
      const stored = history.data[0].items[message.nativePosition.itemIndex];
      // The legacy app-server reader reconstructs item-N ids from JSONL.
      // Paginated storage keeps the actual native id; both must keep position.
      if (historyMode === 'paginated') {
        assert.equal(stored?.id, message.id, 'Live item order must match the persisted native position');
      } else if (message.role === 'user') {
        assert.equal(stored?.clientId, message.clientMessageId, 'Legacy input position must retain its receipt');
      } else {
        assert.equal(stored?.text, message.content, 'Legacy output position must retain its content');
      }
    }
    assert.deepEqual(inputs.map((item: AnyRecord) => item.clientId),
      ['codey-input-first', 'codey-input-second', 'codey-input-repeat']);
    assert.equal(new Set(inputs.map((item: AnyRecord) => item.id)).size, 3);
    const normalized = inputs.flatMap((item: AnyRecord) =>
      projectCodexDaemonItem(item, '', '2026-09-14T06:00:00.000Z')
        .flatMap((raw) => provider.normalizeMessage(raw, 'app')));
    assert.deepEqual(normalized.map((message: AnyRecord) => message.clientMessageId),
      ['codey-input-first', 'codey-input-second', 'codey-input-repeat']);

    // Stop safety relies on native atomic turn-id validation, not only on
    // browser/runtime state (completion notifications can reach clients late).
    released = false;
    const requestCount = modelRequests.length;
    const successor = await owner.request('turn/start', {
      threadId, input: [{ type: 'text', text: 'Isolated successor task' }],
    });
    await until(() => modelRequests.length > requestCount);
    await assert.rejects(owner.request('turn/interrupt', { threadId, turnId }), /expected active turn id/);
    const afterStaleStop = await owner.request('thread/turns/list', {
      threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary',
    });
    assert.equal(afterStaleStop.data[0].id, successor.turn.id);
    assert.equal(afterStaleStop.data[0].status, 'inProgress');
    assert.equal(afterStaleStop.data[0].completedAt, null);
    await owner.request('turn/interrupt', { threadId, turnId: successor.turn.id });
  } finally {
    for (const client of clients) client.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // Only the isolated process group created above, never the desktop daemon.
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      await Promise.race([exited, delay(2_000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
        await exited;
      }
    }
    await running;
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
