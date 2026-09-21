import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { createCodexSessionTitleService } from '@/modules/providers/list/codex/codex-session-title.service.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { AnyRecord, ICodexRpcClient, IProvider } from '@/shared/index.js';

// Real installed Codex, isolated homes and a localhost fake model only.
// Never contact a real model, desktop daemon or existing user conversation.
for (const historyMode of ['legacy', 'paginated']) {
  test(`automatic titles reach real native ${historyMode} storage without adding a conversation turn`, {
    skip: process.env.CODEY_TEST_NATIVE_AUTO_TITLE !== '1', concurrency: false, timeout: 90_000,
  }, async () => {
    const executable = process.env.CODEY_TEST_CODEX_EXECUTABLE;
    assert.ok(executable && path.isAbsolute(executable), 'Set an absolute CODEY_TEST_CODEX_EXECUTABLE');
    const root = await mkdtemp(path.join(os.tmpdir(), 'codey-native-title-'));
    const workspace = path.join(root, 'workspace');
    const values = {
      HOME: root, USERPROFILE: root, CODEX_HOME: root, DATABASE_PATH: path.join(root, 'auth.db'),
      CODEY_CODEX_EXECUTABLE: executable, CODEY_CODEX_DAEMON_SOCKET: '', CODEY_CODEX_RUNTIME_TRANSPORT: '',
      OPENAI_API_KEY: '', OPENAI_BASE_URL: '', CODEY_MODEL_API_KEY: '',
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const clients: ICodexRpcClient[] = [];
    const modelRequests: AnyRecord[] = [];
    const titleRpcCalls: string[] = [];
    const readerLoadedThreads: unknown[] = [];
    const messages: AnyRecord[] = [];
    const notices: string[] = [];
    const warnings: string[] = [];
    let finishUserResponse = () => {};
    let userRun: Promise<unknown> | undefined;
    let titleJob: Promise<void> | undefined;
    let announceTitleJob = () => {};
    let announceUserRequest = () => {};
    const titleScheduled = new Promise<void>(resolve => { announceTitleJob = resolve; });
    const userRequestArrived = new Promise<void>(resolve => { announceUserRequest = resolve; });
    const appId = 'codey-title-app';
    const originalMessage = 'Please investigate why the Mac node went offline.';
    const generatedTitle = 'Investigate offline Mac node';
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      modelRequests.push(body);
      const titleRequest = body.text?.format?.name === 'conversation_title';
      const item = {
        id: titleRequest ? 'title-item' : 'user-turn-item',
        type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text',
          text: titleRequest ? JSON.stringify({ title: generatedTitle }) : 'Offline fixture answer.',
          annotations: [],
        }],
      };
      const result = {
        id: titleRequest ? 'title-response' : 'user-response',
        object: 'response', status: 'completed', model: 'fixture-model', output: [item],
        usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
      };
      if (titleRequest) {
        assert.equal(body.stream, false);
        assert.deepEqual(body.tools, []);
        assert.equal(body.input[0].content[0].text, originalMessage);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({
        type: 'response.created', response: { ...result, status: 'in_progress', output: [] },
      })}\n\n`);
      // Keep the user turn active while a separate metadata reader names it.
      // This proves naming does not acquire the foreign thread writer.
      finishUserResponse = () => {
        for (const event of [
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: result },
        ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      };
      announceUserRequest();
    });
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Offline automatic-title fixture timed out')), 20_000);
        })]);
      } finally { clearTimeout(timer); }
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
name = "Offline title fixture"
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
      sessionsDb.createAppSession(appId, 'codex', workspace, 'Please investigate why the');
      sessionsDb.setSessionModel(appId, 'fixture-model');
      const owner = await CodexStdioClient.connect({ executable, home: root });
      clients.push(owner);
      const ownerRequest = owner.request.bind(owner);
      owner.request = (method, params) => ownerRequest(method, method === 'thread/start'
        ? { ...params, historyMode } : params);
      const runtime = new CodexSharedRuntime({
        run: async () => assert.fail('No SDK fallback in the native title fixture'), abort: () => false,
      }, async () => owner);
      const titleService = createCodexSessionTitleService({
        connect: async () => {
          const reader = await CodexStdioClient.connect({ executable, home: root });
          clients.push(reader);
          const rpc = reader.request.bind(reader);
          reader.request = (method, params) => { titleRpcCalls.push(method); return rpc(method, params); };
          const close = reader.close.bind(reader);
          let closing = false;
          reader.close = async () => {
            if (closing) return close();
            closing = true;
            try { readerLoadedThreads.push((await rpc('thread/loaded/list', {})).data); }
            finally { await close(); }
          };
          return reader;
        },
        notify: async id => { notices.push(id); },
        warn: message => { warnings.push(message); },
      });
      const provider = {
        id: 'codex', runtime,
        auth: { getStatus: async () => ({ installed: true }) },
        sessions: { normalizeMessage: () => [] },
      } as unknown as IProvider;
      const dispatcher = createProviderRuntimeService({
        listProviders: () => [provider], resolveProvider: () => provider,
        resolveProviderSessionId: id => id ? sessionsDb.getSessionById(id)?.provider_session_id ?? null : null,
        resolveResumeModel: async () => 'fixture-model',
        getProviderModels: async () => ({
          DEFAULT: 'fixture-model', OPTIONS: [{ value: 'fixture-model', label: 'Offline fixture' }],
        }),
        scheduleTitle: input => {
          titleJob = titleService.schedule(input);
          announceTitleJob();
          return titleJob;
        },
      });
      userRun = dispatcher.run('codex', originalMessage, { sessionId: appId, cwd: workspace }, {
        isWebSocketWriter: true,
        setSessionId: id => sessionsDb.assignProviderSessionId(appId, id),
        send: message => { messages.push(message as AnyRecord); },
      });
      await bounded(titleScheduled);
      await bounded(titleJob!);
      const named = sessionsDb.getSessionById(appId);
      assert.equal(named?.custom_name, generatedTitle, `background warnings: ${warnings.join('; ')}`);
      assert.equal(named?.custom_name_source, 'auto');
      assert.deepEqual(notices, [appId]);
      assert.deepEqual(readerLoadedThreads, [[]]);
      assert.ok(!titleRpcCalls.some(method => /^(turn\/|thread\/(?:start|resume|fork))/.test(method)));
      assert.equal(messages.some(message => message.kind === 'complete'), false);
      await bounded(userRequestArrived);
      finishUserResponse();
      await bounded(userRun);
      assert.equal(messages.at(-1)?.success, true);
      assert.equal(modelRequests.length, 2, 'one actual turn and one independent title request');

      const check = await CodexStdioClient.connect({ executable, home: root });
      clients.push(check);
      const thread = await check.request('thread/read', { threadId: named!.provider_session_id, includeTurns: false });
      assert.equal(thread.thread.name, generatedTitle);
      const history = await check.request('thread/turns/list', {
        threadId: named!.provider_session_id, limit: 10, sortDirection: 'asc', itemsView: 'full',
      });
      assert.equal(history.data.length, 1, 'the title prompt must not create a hidden turn');
      const user = history.data[0].items.find((item: AnyRecord) => item.type === 'userMessage');
      assert.equal(user.content.find((item: AnyRecord) => item.type === 'text')?.text, originalMessage);
      assert.deepEqual((await check.request('thread/loaded/list', {})).data, []);
    } finally {
      finishUserResponse();
      server.closeAllConnections();
      await Promise.allSettled(clients.map(client => client.close()));
      if (userRun) await bounded(userRun).catch(() => {});
      if (titleJob) await bounded(titleJob).catch(() => {});
      await new Promise<void>(resolve => server.close(() => resolve()));
      closeConnection();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
