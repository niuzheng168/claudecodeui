import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { connectCodexNativeClient } from '@/modules/providers/list/codex/codex-native-client.service.js';
import { synchronizeCodexDaemonSessions } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord, ICodexRpcClient, ProviderRuntimeContext } from '@/shared/index.js';

// Explicit opt-in, isolated homes and an offline localhost model. Never use
// real credentials, a running desktop, or any existing user conversation.
const native = {
  skip: process.env.CODEY_TEST_NATIVE_INTEROP !== '1',
  concurrency: false,
  // Several real processes are started sequentially, each with its own bounded
  // RPC deadline. Leave room for slower CI hosts without weakening those bounds.
  timeout: 180_000,
};

const nativeCases = ['paginated', 'legacy'].flatMap(historyMode =>
  [false, true].map(interruptBeforeContinuation => ({ historyMode, interruptBeforeContinuation })));
for (const { historyMode, interruptBeforeContinuation } of nativeCases) {
  test(`real native ${historyMode} sessions round-trip ${interruptBeforeContinuation ? 'after desktop interruption' : 'after normal completion'} without changing IDs`, native, async t => {
    const executable = process.env.CODEY_TEST_CODEX_EXECUTABLE;
    assert.ok(executable && path.isAbsolute(executable), 'Set an absolute CODEY_TEST_CODEX_EXECUTABLE');
    const ownerExecutable = process.env.CODEY_TEST_CODEX_OWNER_EXECUTABLE || executable;
    assert.ok(path.isAbsolute(ownerExecutable), 'The optional desktop fixture executable must also be absolute');
    const root = await mkdtemp(path.join(os.tmpdir(), 'codey-native-interop-'));
    const workspace = path.join(root, 'workspace');
    const values: Record<string, string> = {
      HOME: root, USERPROFILE: root, CODEX_HOME: root, DATABASE_PATH: path.join(root, 'auth.db'),
      CODEY_CODEX_EXECUTABLE: executable, CODEY_CODEX_DAEMON_SOCKET: '', CODEY_CODEX_RUNTIME_TRANSPORT: '',
      OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const clients: ICodexRpcClient[] = [];
    const calls: Array<{ method: string; params: AnyRecord }> = [];
    const messages: AnyRecord[] = [];
    let responses = 0;
    let holdNextResponse = false;
    let peerServer: net.Server | undefined;
    const peerSockets = new Set<net.Socket>();
    const peerCalls: AnyRecord[] = [];
    let threadId: string | null = null;
    let runtime: CodexSharedRuntime | undefined;
    let pendingRun: Promise<void> | undefined;
    let stage = 'setup';
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (!body) { response.end('{}'); return; }
      const n = ++responses;
      const item = {
        id: `fixture-answer-${n}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text', text: `Offline interop reply ${n}`, annotations: [] }],
      };
      const result = {
        id: `fixture-response-${n}`, object: 'response', status: 'completed', model: 'fixture-model',
        output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (holdNextResponse) {
        holdNextResponse = false;
        response.write(`data: ${JSON.stringify({
          type: 'response.created', response: { ...result, status: 'in_progress', output: [] },
        })}\n\n`);
        return;
      }
      for (const event of [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: result },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Offline native interoperability fixture timed out')), 20_000);
        })]);
      } finally { clearTimeout(timer!); }
    };
    try {
      await mkdir(workspace);
      await writeFile(values.DATABASE_PATH, '');
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      await writeFile(path.join(root, 'config.toml'), `
model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Offline interop fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
`);
      Object.assign(process.env, values);
      closeConnection();
      await initializeDatabase();
      const owner = await CodexStdioClient.connect({ executable: ownerExecutable, home: root });
      clients.push(owner);
      const started = await owner.request('thread/start', { cwd: workspace, historyMode });
      threadId = started.thread.id;
      assert.equal(started.thread.source, 'vscode', 'Native thread/start is visible without spoofing a desktop identity');

      const ownerTurn = async (prompt: string) => {
        let off = () => {};
        const done = new Promise<AnyRecord>(resolve => {
          off = owner.onNotification((method, params) => {
            if (method === 'turn/completed' && params.threadId === threadId) resolve(params.turn);
          });
        });
        try {
          await owner.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
          assert.equal((await bounded(done)).status, 'completed');
        } finally { off(); }
      };
      await ownerTurn('Original desktop fixture prompt');
      if (interruptBeforeContinuation) {
        holdNextResponse = true;
        const started = await owner.request('turn/start', {
          threadId, input: [{ type: 'text', text: 'Interrupted desktop fixture prompt' }],
        });
        await bounded((async () => {
          while (responses !== 2) await new Promise(resolve => setTimeout(resolve, 20));
        })());
        await owner.request('turn/interrupt', { threadId, turnId: started.turn.id });
        await bounded((async () => {
          for (;;) {
            const page = await owner.request('thread/turns/list', {
              threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
            });
            if (page.data[0]?.status === 'interrupted' && Number.isFinite(page.data[0]?.completedAt)) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        })());
        // A real interrupted owner will not automatically consume a new
        // native queue entry. Model the desktop peer's *owner-side* dispatch,
        // while retaining real CLIs, writer locks, storage and model traffic.
        // The separate, opt-in live-session E2E must verify the real app peer.
        await mkdir(path.join(root, 'ipc'), { mode: 0o700 });
        peerServer = net.createServer(socket => {
          peerSockets.add(socket);
          socket.on('close', () => peerSockets.delete(socket));
          socket.on('error', () => {});
          let buffered: Buffer = Buffer.alloc(0);
          const respond = (message: AnyRecord) => {
            const payload = Buffer.from(JSON.stringify(message));
            const frame = Buffer.alloc(4 + payload.length);
            frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
          };
          const handle = async (request: AnyRecord) => {
            peerCalls.push(request);
            if (request.type !== 'request') return;
            const response = { type: 'response', requestId: request.requestId, method: request.method, resultType: 'success' };
            if (request.method === 'initialize') {
              assert.equal(request.params.clientType, 'codey');
              respond({ ...response, result: { clientId: 'codey-fixture-peer' } });
            } else if (request.method === 'thread-owner-discovery') {
              assert.equal(request.params.conversationId, threadId);
              respond({ ...response, handledByClientId: 'fixture-owner', result: { supportsUntrustedAppInput: true } });
            } else if (request.method === 'thread-follower-start-turn') {
              assert.equal(request.targetClientId, 'fixture-owner');
              assert.equal(request.params.conversationId, threadId);
              assert.deepEqual(request.params.turnStart.context, { inheritThreadSettings: true });
              assert.deepEqual(Object.keys(request.params.turnStart.request).sort(), ['clientUserMessageId', 'input', 'threadId']);
              const result = await owner.request('turn/start', request.params.turnStart.request);
              respond({ ...response, handledByClientId: 'fixture-owner', result: { result } });
            } else assert.fail(`Unexpected desktop peer operation: ${request.method}`);
          };
          socket.on('data', data => {
            buffered = Buffer.concat([buffered, data]);
            while (buffered.length >= 4) {
              const length = buffered.readUInt32LE(0);
              if (buffered.length < 4 + length) return;
              const request = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'));
              buffered = buffered.subarray(4 + length);
              void handle(request).catch(error => socket.destroy(error));
            }
          });
        });
        await new Promise<void>((resolve, reject) => {
          peerServer!.once('error', reject);
          peerServer!.listen(path.join(root, 'ipc/ipc.sock'), resolve);
        });
      }
      stage = 'discover and read the desktop thread';
      const originalId = threadId;
      await synchronizeCodexDaemonSessions();
      assert.equal(sessionsDb.getSessionByProviderSessionId(originalId!)?.provider_session_id, originalId);
      const provider = new CodexSessionsProvider();
      const initialHistory = await provider.fetchHistory(originalId!);
      assert.ok(initialHistory.messages.some(message => message.content === 'Offline interop reply 1'));

      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => threadId,
        resolveResumeModel: async () => 'fixture-model',
        getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [] }),
        normalizeMessage: (raw, id) => provider.normalizeMessage(raw, id),
        isProviderInstalled: async () => true,
      };
      runtime = new CodexSharedRuntime({
        run: async () => assert.fail('Native interop must never use exec'), abort: () => false,
      }, async () => {
        const client = await connectCodexNativeClient();
        assert.ok(client);
        clients.push(client);
        const request = client.request.bind(client);
        client.request = (method, params) => {
          calls.push({ method, params });
          return request(method, params);
        };
        return client;
      });
      const run = async (prompt: string) => {
        messages.length = 0;
        pendingRun = runtime!.run(prompt, { sessionId: 'app', cwd: workspace }, {
          isWebSocketWriter: true, setSessionId: id => { threadId = id; },
          send: value => messages.push(value as AnyRecord),
        }, context);
        await bounded(pendingRun);
        assert.deepEqual(messages.filter(message => message.kind === 'error'), []);
        assert.equal(messages.at(-1)?.success, true);
      };
      stage = 'continue through the original desktop owner';
      await run('Codey queued fixture prompt');
      assert.equal(threadId, originalId);
      assert.equal(calls.filter(call => call.method === 'thread/queue/add').length, interruptBeforeContinuation ? 0 : 1);
      assert.equal(peerCalls.filter(call => call.method === 'thread-follower-start-turn').length, interruptBeforeContinuation ? 1 : 0);
      assert.equal(calls.filter(call => call.method === 'turn/start').length, 0);
      assert.ok(!calls.some(call => ['thread/start', 'thread/fork'].includes(call.method)));
      const snapshot = await codexAppServer.readThreadSnapshot(originalId!);
      const prompts = snapshot.turns.flatMap((turn: AnyRecord) => turn.items)
        .filter((item: AnyRecord) => item.type === 'userMessage')
        .map((item: AnyRecord) => item.content.map((part: AnyRecord) => part.text ?? '').join(''));
      assert.deepEqual(prompts, [
        'Original desktop fixture prompt',
        ...(interruptBeforeContinuation ? ['Interrupted desktop fixture prompt'] : []),
        'Codey queued fixture prompt',
      ]);

      // Release only this fixture owner, then prove Codey can resume the same
      // persisted history directly and releases its writer at completion.
      await owner.close();
      stage = 'continue after the original owner exits';
      await run('Codey direct continuation fixture prompt');
      assert.equal(threadId, originalId);
      assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
      const reopened = await CodexStdioClient.connect({ executable: ownerExecutable, home: root });
      clients.push(reopened);
      stage = 'desktop resumes the Codey continuation';
      assert.equal((await reopened.request('thread/resume', { threadId: originalId, excludeTurns: true })).thread.id, originalId);
      assert.equal((await codexAppServer.readThreadSnapshot(originalId!)).turns.length, interruptBeforeContinuation ? 4 : 3);

      // Conversely, new Codey sessions must be discoverable by the ordinary
      // desktop thread/list and resumable without rewriting their source.
      threadId = null;
      stage = 'create a new discoverable Codey session';
      await run('Brand new Codey fixture prompt');
      assert.ok(threadId && threadId !== originalId);
      const listed = await reopened.request('thread/list', { limit: 100 });
      assert.ok(listed.data.some((thread: AnyRecord) => thread.id === threadId));
      stage = 'desktop resumes the new Codey session';
      assert.equal((await reopened.request('thread/resume', { threadId, excludeTurns: true })).thread.id, threadId);
    } catch (error) {
      t.diagnostic(`Stage: ${stage}; Codey RPCs: ${JSON.stringify(calls.map(call => call.method))}`);
      throw error;
    } finally {
      await runtime?.abort('app').catch(() => false);
      await Promise.allSettled(clients.map(client => client.close()));
      await pendingRun?.catch(() => {});
      for (const socket of peerSockets) socket.destroy();
      if (peerServer) await new Promise<void>(resolve => peerServer!.close(() => resolve()));
      closeConnection();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
