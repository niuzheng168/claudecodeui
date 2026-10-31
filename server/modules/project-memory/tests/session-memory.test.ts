import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';

import { ProjectMemoryService } from '../services/project-memory.service.js';
import { MemoryHooksService } from '../services/memory-hooks.service.js';
import { initializeSessionMemory, refreshSessionMemory } from '../services/session-memory.service.js';
import { createProjectMemoryRoutes } from '../project-memory.routes.js';

const PROJECT = `p-${'a'.repeat(16)}`;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-memory-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const service = new ProjectMemoryService({root, fetch: async () => { throw new Error('Reads must not call a model'); }});
  const core = (await service.create('alice', PROJECT, {kind: 'environment', filename: 'core.md', body: '项目核心说明'})).memory;
  const topic = (await service.create('alice', PROJECT, {kind: 'experience', title: '部署经验', filename: 'deploy.md', body: '部署必须运行测试。'.repeat(3000)})).memory;
  return {root, service, core, topic};
}

test('brief revisions omit unchanged text, expose only adopted metadata and read routes never invoke a model', async t => {
  const f = await fixture(t);
  const first = await f.service.briefs('alice', {projects: [{id: PROJECT}]});
  assert.equal(first.projects[0].core, '项目核心说明');
  assert.equal(first.projects[0].coreId, f.core.id);
  assert.equal(first.projects[0].topics[0].id, f.topic.id);
  assert.equal('body' in first.projects[0].topics[0], false);
  assert.deepEqual(await f.service.briefs('alice', {projects: [{id: PROJECT, revision: first.projects[0].revision}]}), {projects: []});
  const found = await f.service.search('alice', PROJECT, {query: '部署测试', limit: 10});
  assert.ok(found.entries.some(entry => entry.id === f.topic.id));
  assert.ok(found.entries.every(entry => entry.snippet.length <= 300));
  assert.equal(first.projects[0].topicCount, 1);
  const other = await f.service.briefs('bob', {projects: [{id: PROJECT}]});
  assert.equal(other.projects[0].core, '');
  await assert.rejects(f.service.read('bob', PROJECT, {id: f.core.id}), {statusCode: 404});
  await f.service.update('alice', PROJECT, f.topic.id, {version: 1, state: 'invalidated'});
  await assert.rejects(f.service.read('alice', PROJECT, {id: f.topic.id}), {statusCode: 404});
  assert.equal((await f.service.briefs('alice', {projects: [{id: PROJECT}]})).projects[0].topics.length, 0);
});

test('search is independent from model budgets and excludes unrelated maintenance rules', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) {
    await f.service.create('alice', PROJECT, {kind: 'rule', filename: `rule-${index}.md`, body: ' unrelated '.repeat(100)});
  }
  const noModelBudget = new ProjectMemoryService({root: f.root, environment: {CODEY_MEMORY_INPUT_TOKENS: 'invalid'}});
  const result = await noModelBudget.search('alice', PROJECT, {query: '部署', limit: 1});
  assert.equal(result.entries[0].id, f.topic.id);
  assert.ok(result.entries[0].snippet.length <= 300);
  assert.match(result.entries[0].snippet, /部署/);
});

test('memory_read pages full UTF-8 content without gaps, rejects invalid offsets, IDs and deleted projects', async t => {
  const f = await fixture(t);
  let offset = 0, text = '';
  for (;;) {
    const page = await f.service.read('alice', PROJECT, {id: f.topic.id, offset});
    assert.ok(Buffer.byteLength(page.body) <= 16384);
    assert.ok(!page.body.includes('\ufffd'));
    text += page.body;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(text, f.topic.body);
  for (const input of [{id: '../core'}, {id: f.topic.id, offset: -1}, {id: f.topic.id, offset: 1}, {id: f.topic.id, offset: 1e9}]) {
    await assert.rejects(f.service.read('alice', PROJECT, input), {statusCode: 400});
  }
  for (const limit of [0, 11, 1.5, '2']) await assert.rejects(f.service.search('alice', PROJECT, {query: '部署', limit}), {statusCode: 400});
  await f.service.remove('alice', PROJECT);
  await assert.rejects(f.service.briefs('alice', {projects: [{id: PROJECT}]}), {statusCode: 404});
});

test('read HTTP routes require signed owner identity and advertise sessionBriefs', async t => {
  const f = await fixture(t);
  const app = express();app.use(express.json());
  app.use(createProjectMemoryRoutes(f.service, req => req.headers['x-owner'] === 'yes', () => 'alice'));
  app.use(((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({error: error.message})) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(() => { server.closeAllConnections();server.close(); });
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  assert.equal((await fetch(`${url}/info`)).status, 403);
  const info = await (await fetch(`${url}/info`, {headers: {'x-owner': 'yes'}})).json() as {features: {sessionBriefs: boolean}};
  assert.equal(info.features.sessionBriefs, true);
  for (const [route, body] of [
    ['/briefs', {projects: [{id: PROJECT}]}],
    [`/projects/${PROJECT}/search`, {query: '部署'}],
    [`/projects/${PROJECT}/read`, {id: f.core.id}],
  ] as const) {
    assert.equal((await fetch(url + route, {method: 'POST', headers: {'x-owner': 'yes', 'content-type': 'application/json'}, body: JSON.stringify(body)})).status, 200);
  }
});

test('installed hook runs in a separate process with a private local cache and bounded stdin', async t => {
  const f = await fixture(t);
  // The node package owns the portable module; this test deliberately runs the
  // installed copy, not a closure inside the Workspace process.
  const modulePath = fileURLToPath(new URL('../../../../../packages/codey/lib/project-memory-cache.mjs', import.meta.url));
  const {ProjectMemoryCache} = await import(modulePath);
  const cache = new ProjectMemoryCache({root: path.join(f.root, '.codey', 'memory-cache')});
  await cache.refresh({
    accountId: 'alice', nodeId: 'test', projects: [{id: PROJECT, name: 'Codey', directories: [{path: '/repo'}]}],
    briefs: (await f.service.briefs('alice', {projects: [{id: PROJECT}]})).projects, sessions: [],
  });
  const hooks = new MemoryHooksService(f.root, {});
  await hooks.install(modulePath);
  const codex = JSON.parse(await readFile(path.join(f.root, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.hooks.SessionStart[0].hooks[0].timeout, 2);
  assert.equal(codex.hooks.SessionStart[0].hooks[0].additionalContextLimit, 6000);
  const run = (input?: object) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(hooks.root, 'project-memory-hook.mjs'), 'SessionStart'], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`hook exited ${code}`)));
    if (input) child.stdin.end(JSON.stringify(input));
  });
  assert.match(JSON.parse(await run({session_id: 'native', cwd: '/repo', source: 'startup'})).hookSpecificOutput.additionalContext, /项目核心说明/);
  assert.equal(await run({session_id: 'native', cwd: '/repo', source: 'resume'}), '');
  assert.equal(await run(), '');
  assert.equal(await hooks.takeWake(), true);
});

test('runtime refresh resolves native aliases, keeps an offline snapshot and clears another account before retrying', async t => {
  const f = await fixture(t);
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(f.root, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  t.after(() => {
    chatRunRegistry.clearAll();closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH = previous;
  });
  sessionsDb.createAppSession('app', 'claude', '/repo', 'Test');
  sessionsDb.assignProviderSessionId('app', 'native');
  const moduleUrl = new URL('../../../../../packages/codey/lib/project-memory-cache.mjs', import.meta.url).href;
  const adapterPath = path.join(f.root, 'adapter.mjs');
  await writeFile(adapterPath, `
    import {ProjectMemoryCache} from ${JSON.stringify(moduleUrl)};
    export const memoryCache=new ProjectMemoryCache({root:${JSON.stringify(path.join(f.root, 'cache'))}});
    export const memoryCacheModule=${JSON.stringify(fileURLToPath(moduleUrl))};
    export const state={owner:'alice',fail:false,requests:[],response:${JSON.stringify({
      projects: [{id: PROJECT, name: 'Codey', directories: []}],
      briefs: (await f.service.briefs('alice', {projects: [{id: PROJECT}]})).projects,
      sessions: [{sessionId: 'app', projectId: PROJECT}],
    })}};
    export async function portalRequest(method,path,{body}) {
      if(path==='/api/v1/me')return {user:{id:state.owner},node:{id:'node'}};
      state.requests.push(body);
      if(state.fail)throw new Error('offline');
      return {...state.response,accountId:state.owner,nodeId:'node'};
    }
  `);
  const adapter = await import(pathToFileURL(adapterPath).href);
  await initializeSessionMemory(adapterPath);
  await refreshSessionMemory();
  assert.equal((await adapter.memoryCache.resolve({sessionId: 'native', cwd: '/unrelated'})).id, PROJECT);
  const before = await adapter.memoryCache.snapshot();
  adapter.state.fail = true;
  await assert.rejects(refreshSessionMemory(), /offline/);
  assert.deepEqual(await adapter.memoryCache.snapshot(), before);
  adapter.state.owner = 'bob';
  await assert.rejects(refreshSessionMemory(), /offline/);
  assert.equal((await adapter.memoryCache.snapshot()).accountId, 'bob');
  assert.deepEqual((await adapter.memoryCache.snapshot()).projects, []);

  adapter.state.owner = 'alice';adapter.state.fail = false;
  await refreshSessionMemory();
  // Exercise the real dispatch boundary: the ticket precedes the provider
  // launch and a browser cannot choose an arbitrary existing ticket.
  for (const provider of ['claude', 'codex'] as const) {
    const app = `new-${provider}`, native = `native-${provider}`;
    sessionsDb.createAppSession(app, provider, '/unrelated', 'New');
    let observed = false;
    const result = await runDetachedChatTurn({
      sessionId: app, userId: 1, content: 'hello',
      options: {workbenchProjectId: PROJECT, memoryLaunchId: 'untrusted-browser-token'},
    }, {runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, _command: string, options: Record<string, unknown>) => {
        observed = true;
        if (provider === 'claude') assert.match(String(options.memoryLaunchId), /^[a-f0-9]{32}$/);
        else assert.equal(options.memoryLaunchId, undefined);
        const selected = await adapter.memoryCache.resolve({
          sessionId: native, cwd: '/unrelated', startup: true, launchId: options.memoryLaunchId, provider,
        });
        assert.equal(selected.id, PROJECT);
      },
    } as never});
    assert.equal(result.error, null);assert.equal(observed, true);
    assert.deepEqual(await readdir(path.join(f.root, 'cache', 'launches')), []);
  }
});
