import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CodexDesktopPeerClient } from '@/modules/providers/list/codex/codex-desktop-peer.client.js';
import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord, ICodexRpcClient, ProviderRuntimeContext } from '@/shared/index.js';

// Two real native processes, a protocol-level desktop peer and an offline
// localhost model. This validates writer/storage/queue semantics, not the
// actual desktop UI. No real credentials or existing conversation is used.
for (const historyMode of ['paginated', 'legacy'] as const) {
  test(`real private-stdio ${historyMode} sessions allow bidirectional peer input, queueing and Stop`, {
    skip: process.env.CODEY_TEST_NATIVE_INTEROP !== '1', timeout: 90_000, concurrency: false,
  }, async () => {
    const executable = process.env.CODEY_TEST_CODEX_EXECUTABLE;
    const ownerExecutable = process.env.CODEY_TEST_CODEX_OWNER_EXECUTABLE ?? executable;
    assert.ok(executable && path.isAbsolute(executable));
    assert.ok(ownerExecutable && path.isAbsolute(ownerExecutable));
    const root = await mkdtemp(path.join(os.tmpdir(), 'codey-peer-native-'));
    const workspace = path.join(root, 'workspace');
    const clients: ICodexRpcClient[] = [];
    const sockets = new Set<net.Socket>();
    const helperCalls: string[] = [], peerCalls: AnyRecord[] = [], messages: AnyRecord[] = [];
    const modelRequests: AnyRecord[] = [];
    const pendingResponses: Array<() => void> = [];
    let released = false;
    let runtime: CodexSharedRuntime | undefined;
    let running: Promise<void> | undefined;
    let peerServer: net.Server | undefined;
    const model = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (!body) { response.end('{}'); return; }
      modelRequests.push(JSON.parse(body));
      const n = modelRequests.length;
      const finish = () => {
        if (response.destroyed) return;
        const item = {
          id: `reply-${n}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
          content: [{ type: 'output_text', text: `Offline peer reply ${n}`, annotations: [] }],
        };
        const result = {
          id: `response-${n}`, object: 'response', status: 'completed', model: 'fixture-model',
          output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
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
      if (released) finish(); else pendingResponses.push(finish);
    });
    const release = () => { released = true; for (const finish of pendingResponses.splice(0)) finish(); };
    const until = async (condition: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 15_000;
      while (!await condition()) {
        if (Date.now() >= deadline) assert.fail(`Offline peer fixture timed out: ${JSON.stringify(messages)}`);
        await delay(15);
      }
    };
    try {
      await mkdir(workspace);
      await mkdir(path.join(root, 'ipc'), { mode: 0o700 });
      await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
      const { port } = model.address() as { port: number };
      await writeFile(path.join(root, 'config.toml'), `
model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Offline desktop peer fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
`);
      const owner = await CodexStdioClient.connect({ executable: ownerExecutable, home: root });
      clients.push(owner);
      const created = await owner.request('thread/start', { cwd: workspace, historyMode });
      const threadId = created.thread.id;
      const turns = async () => (await owner.request('thread/turns/list', {
        threadId, limit: 20, sortDirection: 'asc', itemsView: 'full',
      })).data as AnyRecord[];
      peerServer = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let buffered: Buffer = Buffer.alloc(0);
        const send = (message: AnyRecord) => {
          const payload = Buffer.from(JSON.stringify(message)), frame = Buffer.alloc(payload.length + 4);
          frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
        };
        const handle = async (message: AnyRecord) => {
          if (message.type === 'broadcast' && message.method === 'thread-stream-following-changed') {
            if (!message.params.following) return;
            const history = await turns();
            send({
              type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'native-owner',
              params: { hostId: 'local', conversationId: threadId, change: {
                type: 'snapshot', revision: 1,
                conversationState: {
                  id: threadId, cwd: workspace,
                  turns: history.map(turn => ({ turnId: turn.id, status: turn.status })),
                },
              } },
            });
            return;
          }
          if (message.type !== 'request') return;
          peerCalls.push(message);
          const response = {
            type: 'response', requestId: message.requestId, method: message.method,
            resultType: 'success', handledByClientId: 'native-owner',
          };
          if (message.method === 'initialize') {
            assert.equal(message.params.clientType, 'codey');
            send({ ...response, result: { clientId: 'codey-peer' } });
          } else if (message.method === 'thread-owner-discovery') {
            assert.equal(message.params.conversationId, threadId);
            send({ ...response, result: { supportsUntrustedAppInput: true } });
          } else if (message.method === 'thread-follower-start-turn') {
            assert.equal(message.targetClientId, 'native-owner');
            assert.deepEqual(message.params.turnStart.context, { inheritThreadSettings: true });
            send({ ...response, result: { result: await owner.request('turn/start', message.params.turnStart.request) } });
          } else if (message.method === 'thread-follower-steer-turn') {
            assert.equal(message.version, 1);
            assert.equal(message.targetClientId, 'native-owner');
            const active = (await turns()).at(-1)!;
            const result = await owner.request('turn/steer', {
              threadId, expectedTurnId: active.id, input: message.params.input,
              clientUserMessageId: message.params.clientUserMessageId,
            });
            send({ ...response, result: { result } });
          } else if (message.method === 'thread-follower-interrupt-turn') {
            assert.equal(message.version, 4);
            assert.equal(message.targetClientId, 'native-owner');
            await owner.request('turn/interrupt', { threadId, turnId: message.params.expectedTurnId });
            send({ ...response, result: { ok: true, interruptedTurnId: message.params.expectedTurnId } });
          } else assert.fail(`Unexpected peer request ${message.method}`);
        };
        socket.on('data', data => {
          buffered = Buffer.concat([buffered, data]);
          while (buffered.length >= 4) {
            const n = buffered.readUInt32LE(0);
            if (buffered.length < n + 4) return;
            const message = JSON.parse(buffered.subarray(4, n + 4).toString());
            buffered = buffered.subarray(n + 4);
            void handle(message).catch(error => socket.destroy(error));
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        peerServer!.once('error', reject); peerServer!.listen(path.join(root, 'ipc/ipc.sock'), resolve);
      });
      runtime = new CodexSharedRuntime({
        run: async () => assert.fail('Never use exec for peer interoperability'), abort: () => false,
      }, async () => {
        const client = await CodexStdioClient.connect({ executable, home: root });
        clients.push(client);
        const request = client.request.bind(client);
        client.request = (method, params) => { helperCalls.push(method); return request(method, params); };
        return client;
      }, async () => assert.fail('Never start an alternate writer'),
      id => CodexDesktopPeerClient.connect(id, { home: root }));
      const provider = new CodexSessionsProvider();
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => threadId,
        resolveResumeModel: async () => 'fixture-model',
        getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [] }),
        normalizeMessage: (raw, id) => provider.normalizeMessage(raw, id), isProviderInstalled: async () => true,
      };
      const writer = { isWebSocketWriter: true, send: (value: unknown) => { messages.push(value as AnyRecord); } };
      const first = await owner.request('turn/start', {
        threadId, input: [{ type: 'text', text: 'Original desktop task' }],
      });
      await until(() => modelRequests.length > 0);
      const observation = await runtime.prepareObservation('app', context);
      assert.ok(observation);
      running = observation.start(writer);
      await until(() => runtime!.canSteer('app'));
      assert.equal(runtime.canInterrupt('app'), true);
      await runtime.steer('app', 'Codey correction', { clientMessageId: 'codey-one' });
      await owner.request('turn/steer', {
        threadId, expectedTurnId: first.turn.id, input: [{ type: 'text', text: 'Desktop correction' }],
        clientUserMessageId: 'desktop-one',
      });
      await runtime.steer('app', 'Codey correction', { clientMessageId: 'codey-repeat' });
      release();
      await until(() => !runtime!.canSteer('app'));
      await running;
      let history = await turns();
      assert.deepEqual(history.map(turn => turn.id), [first.turn.id]);
      assert.deepEqual(history[0].items.filter((item: AnyRecord) => item.clientId).map((item: AnyRecord) => item.clientId),
        ['codey-one', 'desktop-one', 'codey-repeat']);
      assert.match(JSON.stringify(modelRequests), /Desktop correction/);
      assert.match(JSON.stringify(modelRequests), /Codey correction/);
      assert.ok(messages.some(message => message.clientMessageId === 'desktop-one'));
      assert.equal(messages.filter(message => message.kind === 'complete').length, 1);
      assert.equal(messages.at(-1)?.success, true);

      // The inverse direction: a Codey continuation must remain desktop-owned,
      // so desktop steering and its native queue work during the Codey run.
      released = false;
      messages.length = 0;
      running = runtime.run('Codey continuation', { sessionId: 'app', clientMessageId: 'codey-next' }, writer, context);
      await until(() => runtime!.canSteer('app'));
      const second = (await turns()).at(-1)!;
      assert.notEqual(second.id, first.turn.id);
      await owner.request('turn/steer', {
        threadId, expectedTurnId: second.id, input: [{ type: 'text', text: 'Desktop during Codey continuation' }],
        clientUserMessageId: 'desktop-two',
      });
      await owner.request('thread/queue/add', {
        threadId, input: [{ type: 'text', text: 'Desktop queued followup' }], clientUserMessageId: 'desktop-queued',
      });
      release();
      await until(() => !runtime!.canSteer('app'));
      await running;
      await until(async () => {
        const page = await turns();
        return page.length === 3 && Number.isFinite(page[2].completedAt);
      });
      history = await turns();
      assert.deepEqual(history[1].items.filter((item: AnyRecord) => item.clientId).map((item: AnyRecord) => item.clientId),
        ['codey-next', 'desktop-two']);
      assert.ok(history[2].items.some((item: AnyRecord) => item.clientId === 'desktop-queued'));
      assert.deepEqual((await owner.request('thread/queue/list', { threadId })).data, []);
      assert.equal(peerCalls.filter(call => call.method === 'thread-follower-start-turn').length, 1);
      assert.ok(!helperCalls.some(method => [
        'thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/queue/add',
      ].includes(method)));

      // Explicit Stop addresses the captured turn; disconnects and generic
      // cancellation do not assume ownership of native desktop work.
      released = false;
      const final = await owner.request('turn/start', {
        threadId, input: [{ type: 'text', text: 'Stop only this isolated turn' }],
      });
      const stopping = await runtime.prepareObservation('app', context);
      assert.ok(stopping);
      messages.length = 0;
      running = stopping.start(writer);
      await until(() => runtime!.canSteer('app'));
      await assert.rejects(runtime.abort('app'), { code: 'CODEX_DESKTOP_TURN_NOT_OWNED' });
      assert.equal(await runtime.abort('app', { allowExternalTurn: true }), true);
      await running;
      history = await turns();
      assert.equal(history.at(-1)?.id, final.turn.id);
      assert.equal(history.at(-1)?.status, 'interrupted');
      assert.ok(Number.isFinite(history.at(-1)?.completedAt));
      assert.deepEqual(messages.filter(message => message.kind === 'error'), []);
    } finally {
      release();
      await runtime?.abort('app', { allowExternalTurn: true }).catch(() => false);
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled(clients.map(client => client.close()));
      await running?.catch(() => {});
      if (peerServer) await new Promise<void>(resolve => peerServer!.close(() => resolve()));
      model.closeAllConnections();
      await new Promise<void>(resolve => model.close(() => resolve()));
      // Native bootstrap helpers may finish writing their plugin cache just
      // after the app-server exits. Retry only cleanup of this fixture's home.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
