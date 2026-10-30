import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { ProjectMemoryService, readProjectMemoryMaterial } from '../services/project-memory.service.js';
import { createProjectMemoryRoutes } from '../project-memory.routes.js';

const PROJECT = `p-${'a'.repeat(16)}`;
const OTHER = `p-${'b'.repeat(16)}`;
const SOURCE = `session:n-${'a'.repeat(24)}/s-1`;
const event = (n = 1) => ({ eventId: String(n).padStart(64, '0'), source: SOURCE, outcome: 'completed', transcript: 'user: use Postgres\nassistant: verified migrations' });
const addition = (filename = 'facts.md') => ({ upserts: [{ id: null, filename, kind: 'fact', body: 'Uses PostgreSQL.' }], remove: [] });
const completed = (patch: unknown) => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(patch) }] }],
}));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codey-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Record<string, any>[] = [];
  const response = { make: async () => completed(addition()) };
  const dependencies = {
    root, environment: {},
    modelEndpoint: () => ({ url: 'http://127.0.0.1:4141/responses', headers: { authorization: 'Bearer test' } }),
    fetch: (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return response.make();
    }) as typeof fetch,
  };
  return { root, calls, response, dependencies, service: new ProjectMemoryService(dependencies) };
}

test('multiple Markdown memories survive restart, with owner/project isolation, edit history and deletion', async t => {
  const f = await fixture(t);
  const a = (await f.service.create('alice', PROJECT, { filename: '架构.md', kind: 'decision', body: '# Architecture\n\nUse PostgreSQL.' })).memory;
  const b = (await f.service.create('alice', PROJECT, { filename: 'tests.md', kind: 'experience', body: 'Run node --test.' })).memory;
  assert.deepEqual([a.source, a.state, a.version], ['user', 'adopted', 1]);
  const restarted = new ProjectMemoryService(f.dependencies);
  assert.equal((await restarted.list('alice', PROJECT)).memory.length, 2);
  assert.equal((await restarted.list('bob', PROJECT)).memory.length, 0);
  assert.equal((await restarted.list('alice', OTHER)).memory.length, 0);
  const updated = (await restarted.update('alice', PROJECT, a.id, { body: '# Updated', filename: 'architecture.md', version: 1 })).memory;
  assert.equal(updated.version, 2);
  assert.equal(updated.filename, 'architecture.md');
  await assert.rejects(restarted.update('alice', PROJECT, a.id, { body: 'stale', version: 1 }), { statusCode: 409 });
  await assert.rejects(restarted.update('bob', PROJECT, a.id, { body: 'steal', version: 2 }), { statusCode: 404 });
  assert.deepEqual((await restarted.history('alice', PROJECT, a.id)).history.map(entry => entry.body), ['# Updated', a.body]);
  const directories = await readdir(path.join(f.root, PROJECT));
  const files = await readdir(path.join(f.root, PROJECT, directories.find(name => name !== '')!, 'memory'));
  assert.ok(files.some(file => file.endsWith('.md')));
  await restarted.remove('alice', PROJECT, b.id);
  assert.equal((await restarted.list('alice', PROJECT)).memory.length, 1);
  await assert.rejects(restarted.history('alice', PROJECT, b.id), { statusCode: 404 });
});

test('filenames, credentials, byte limits and unknown fields are rejected without a model call', async t => {
  const f = await fixture(t);
  for (const body of [
    { filename: '../outside.md' }, { filename: '/tmp/a.md' }, { filename: 'a/b.md' }, { filename: 'a\\b.md' },
    { filename: 'a.txt' }, { body: '' }, { body: '记'.repeat(2731) }, { body: `ghp_${'x'.repeat(36)}` },
    { state: 'candidate' }, { kind: 'unknown' }, { owner: 'bob' },
  ]) {
    await assert.rejects(f.service.create('alice', PROJECT, { kind: 'fact', body: 'valid', ...body }), { statusCode: 400 });
  }
  await assert.rejects(f.service.create('alice', '../escape', { kind: 'fact', body: 'valid' }), { statusCode: 400 });
  await f.service.create('alice', PROJECT, { kind: 'fact', body: 'valid', filename: 'a.md' });
  await assert.rejects(f.service.create('alice', PROJECT, { kind: 'fact', body: 'duplicate', filename: 'A.md' }), { statusCode: 409 });
  assert.equal(f.calls.length, 0);
});

test('a completed session invokes the small model and atomically persists a replay receipt', async t => {
  const f = await fixture(t);
  const result = await f.service.summarize('alice', PROJECT, event());
  assert.equal(result.updated, true);
  assert.equal(f.calls[0].model, 'gpt-6.1-terra');
  assert.equal(f.calls[0].store, false);
  assert.deepEqual(f.calls[0].tools, []);
  assert.equal((await f.service.list('alice', PROJECT)).memory[0].state, 'adopted');
  assert.equal((await f.service.list('alice', PROJECT)).memory[0].source, SOURCE);
  const restarted = new ProjectMemoryService(f.dependencies);
  assert.equal((await restarted.summarize('alice', PROJECT, event())).replayed, true);
  assert.equal(f.calls.length, 1);
  f.response.make = async () => completed({ upserts: [], remove: [] });
  assert.equal((await restarted.summarize('alice', PROJECT, event(2))).updated, false);
  assert.equal((await restarted.summarize('alice', PROJECT, event(2))).replayed, true);
});

test('model failures are retryable and never produce a fabricated or partially saved memory', async t => {
  const f = await fixture(t);
  for (const make of [
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('not JSON'),
    async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })),
    async () => completed({ ...addition(), extra: true }),
    async () => completed({ upserts: [...addition().upserts, { ...addition().upserts[0], filename: 'bad.md', body: `sk-${'a'.repeat(40)}` }], remove: [] }),
    async () => completed({ upserts: [...addition().upserts, addition().upserts[0]], remove: [] }),
  ]) {
    f.response.make = make;
    await assert.rejects(f.service.summarize('alice', PROJECT, event()));
    assert.equal((await f.service.list('alice', PROJECT)).memory.length, 0);
  }
  f.response.make = async () => completed(addition());
  assert.equal((await f.service.summarize('alice', PROJECT, event())).updated, true);
});

test('automatic summaries update automatic files, but may not overwrite manually edited files', async t => {
  const f = await fixture(t);
  await f.service.summarize('alice', PROJECT, event());
  const a = (await f.service.list('alice', PROJECT)).memory[0];
  f.response.make = async () => completed({ upserts: [{ ...addition().upserts[0], id: a.id, body: 'PostgreSQL 16 verified.' }], remove: [] });
  await f.service.summarize('alice', PROJECT, event(2));
  const updated = (await f.service.list('alice', PROJECT)).memory[0];
  assert.equal(updated.version, 2);
  await f.service.update('alice', PROJECT, a.id, { version: 2, body: 'Only PostgreSQL 16 is supported.' });
  await assert.rejects(f.service.summarize('alice', PROJECT, event(3)), { statusCode: 409 });
  f.response.make = async () => completed({ upserts: [], remove: [a.id] });
  await assert.rejects(f.service.summarize('alice', PROJECT, event(4)), { statusCode: 409 });
  assert.equal((await f.service.list('alice', PROJECT)).memory[0].body, 'Only PostgreSQL 16 is supported.');
});

test('a user edit during inference wins; a stale patch is retried against new context', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.response.make = async () => { entered(); await wait; return completed(addition()); };
  const summarizing = f.service.summarize('alice', PROJECT, event());
  await started;
  await f.service.create('alice', PROJECT, { filename: 'manual.md', kind: 'decision', body: 'Do not deploy.' });
  release();
  await assert.rejects(summarizing, { statusCode: 409 });
  assert.deepEqual((await f.service.list('alice', PROJECT)).memory.map(entry => entry.filename), ['manual.md']);
  f.response.make = async () => completed(addition());
  assert.equal((await f.service.summarize('alice', PROJECT, event())).updated, true);
});

test('parallel store instances serialize writes and reject one of two changes with the same version', async t => {
  const f = await fixture(t);
  const other = new ProjectMemoryService(f.dependencies);
  const { memory } = await f.service.create('alice', PROJECT, { kind: 'fact', body: 'original' });
  const results = await Promise.allSettled([
    f.service.update('alice', PROJECT, memory.id, { version: 1, body: 'first' }),
    other.update('alice', PROJECT, memory.id, { version: 1, body: 'second' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await other.list('alice', PROJECT)).memory[0].version, 2);
});

test('legacy migration is idempotent and deleting a project removes Markdown and prevents resurrection', async t => {
  const f = await fixture(t);
  const legacy = { id: `m-${'a'.repeat(16)}`, kind: 'fact', body: 'legacy fact', source: 'user', state: 'adopted', version: 3 };
  assert.equal((await f.service.importLegacy('alice', PROJECT, { memory: [legacy] })).imported, true);
  assert.equal((await f.service.importLegacy('alice', PROJECT, { memory: [legacy] })).imported, false);
  assert.equal((await f.service.list('alice', PROJECT)).memory[0].version, 3);
  await f.service.remove('alice', PROJECT);
  await f.service.remove('alice', PROJECT);
  await assert.rejects(f.service.list('alice', PROJECT), { statusCode: 404 });
  await assert.rejects(f.service.summarize('alice', PROJECT, event()), { statusCode: 404 });
  const ownerDir = (await readdir(path.join(f.root, PROJECT)))[0];
  const files = await readdir(path.join(f.root, PROJECT, ownerDir, 'memory'));
  assert.deepEqual(files, ['index.json']);
  assert.equal((await readFile(path.join(f.root, PROJECT, ownerDir, 'memory/index.json'), 'utf8')).includes('legacy fact'), false);
});

test('credentials are redacted from material before the model call', async t => {
  const f = await fixture(t);
  await f.service.summarize('alice', PROJECT, { ...event(), transcript: `password=hunter2\nBearer hidden\nsk-${'a'.repeat(40)}\nUser: use Postgres` });
  const input = f.calls[0].input[0].content;
  assert.ok(!input.includes('hunter2') && !input.includes('Bearer hidden') && !input.includes(`sk-${'a'.repeat(40)}`));
  assert.match(input, /credential omitted/);
});

test('history is bounded and discarded versions are physically pruned', async t => {
  const f = await fixture(t);
  const { memory } = await f.service.create('alice', PROJECT, { kind: 'fact', body: 'v1' });
  for (let version = 1; version <= 52; version += 1) {
    await f.service.update('alice', PROJECT, memory.id, { version, body: `v${version + 1}` });
  }
  const history = await f.service.history('alice', PROJECT, memory.id);
  assert.equal(history.history.length, 50);
  assert.equal(history.history[0].version, 53);
  assert.equal(history.history.at(-1)?.version, 4);
  const ownerDir = (await readdir(path.join(f.root, PROJECT)))[0];
  assert.equal((await readdir(path.join(f.root, PROJECT, ownerDir, 'memory'))).filter(file => file.endsWith('.md')).length, 50);
});

test('a deleted project cannot be resurrected by an already-running model', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.response.make = async () => { entered(); await waiting; return completed(addition()); };
  const task = f.service.summarize('alice', PROJECT, event());
  await started;
  await f.service.remove('alice', PROJECT);
  release();
  await assert.rejects(task, { statusCode: 404 });
});

test('the source material excludes later turns, old turns, tool output and reasoning', async () => {
  const through = Date.parse('2026-10-30T12:00:00Z');
  const details = { sessionId: 'app-s', project: null };
  const message = (role: string, content: string, at: number, kind = 'text') => ({
    id: content, sessionId: 'app-s', provider: 'codex', role, content, timestamp: new Date(at).toISOString(), kind,
  });
  const rows = [
    message('user', 'old', through - 3000), message('user', 'current password=hidden', through - 900),
    message('assistant', 'reasoning secret', through - 800, 'thinking'),
    message('assistant', 'tool output secret', through - 700, 'tool_result'),
    message('assistant', 'verified', through - 100), message('assistant', 'future', through + 100),
  ];
  const reader = {
    getSessionDetailsById: () => details,
    fetchHistory: async (id: string) => {
      assert.equal(id, 'app-s');
      return { messages: rows, hasMore: false };
    },
  } as unknown as NonNullable<Parameters<typeof readProjectMemoryMaterial>[3]>;
  const result = await readProjectMemoryMaterial('native-s', through, through - 1000, reader);
  assert.match(result.transcript, /current.*credential omitted/);
  assert.match(result.transcript, /verified/);
  assert.doesNotMatch(result.transcript, /old|future|secret|hidden/);
});

test('node routes require signed owner identity and preserve CRUD status and validation', async t => {
  const f = await fixture(t);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { username: 'alice' } }); next(); });
  app.use('/guarded', createProjectMemoryRoutes(f.service));
  app.use('/test', createProjectMemoryRoutes(f.service, () => true));
  app.use(((error, _req, res, _next) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${base}/test/projects/${PROJECT}/memory`;
  assert.equal((await fetch(`${base}/guarded/projects/${PROJECT}/memory`)).status, 403);
  assert.equal((await fetch(url)).status, 200);
  const created = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'api.md', kind: 'fact', body: 'from API' }) });
  assert.equal(created.status, 201);
  const { memory } = await created.json() as { memory: { id: string } };
  assert.equal((await fetch(`${url}/${memory.id}`)).status, 200);
  assert.equal((await fetch(url, { method: 'PUT' })).status, 405);
  assert.equal((await fetch(`${url}/${memory.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${url}/${memory.id}`)).status, 404);
});

test('resources join an existing project once, retaining full bodies, titles, kind, timestamps and provenance', async t => {
  const f = await fixture(t);
  const { memory: existing } = await f.service.create('alice', PROJECT, { kind: 'fact', body: 'already on main' });
  const resource = { id: `r-${'c'.repeat(16)}`, title: '开发环境', kind: 'environment', body: 'x'.repeat(8192), createdAt: 123, updatedAt: 456 };
  const imported = await f.service.importLegacy('alice', PROJECT, { memory: [], resources: [resource] });
  assert.equal(imported.resourcesImported, true);
  assert.equal(imported.contract, 2);
  const files = (await f.service.list('alice', PROJECT)).memory;
  assert.equal(files.length, 2);
  assert.ok(files.some(file => file.id === existing.id));
  const migrated = files.find(file => file.legacyResourceId === resource.id)!;
  assert.deepEqual([migrated.title, migrated.kind, migrated.body, migrated.createdAt, migrated.updatedAt, migrated.mode],
    [resource.title, resource.kind, resource.body, 123, 456, 'manual']);
  assert.equal(migrated.source, `resource:${resource.id}`);
  assert.match(migrated.filename, /^开发环境-/);
  await f.service.update('alice', PROJECT, migrated.id, { version: 1, title: 'New title', body: 'changed by user' });
  await f.service.importLegacy('alice', PROJECT, { memory: [], resources: [resource] });
  assert.equal((await f.service.history('alice', PROJECT, migrated.id)).memory.body, 'changed by user');
  await f.service.remove('alice', PROJECT, migrated.id);
  const restarted = new ProjectMemoryService(f.dependencies);
  await restarted.importLegacy('alice', PROJECT, { memory: [], resources: [resource] });
  assert.equal((await restarted.list('alice', PROJECT)).memory.length, 1, 'a deleted migrated file stays deleted after restart/reimport');
});

test('resource import is all-or-nothing and may be retried after validation failure', async t => {
  const f = await fixture(t);
  const resource = { id: `r-${'c'.repeat(16)}`, title: 'Rules', kind: 'rule', body: 'valid' };
  await assert.rejects(f.service.importLegacy('alice', PROJECT, {
    memory: [], resources: [resource, { ...resource, id: 'invalid' }],
  }));
  assert.equal((await f.service.list('alice', PROJECT)).memory.length, 0);
  assert.equal((await f.service.importLegacy('alice', PROJECT, { memory: [], resources: [resource] })).resourcesImported, true);
});

test('users explicitly enable and disable automatic maintenance, independently of source and category', async t => {
  const f = await fixture(t);
  const { memory } = await f.service.create('alice', PROJECT, { kind: 'rule', title: 'Rules', body: 'initial rule' });
  assert.equal(memory.mode, 'manual');
  f.response.make = async () => completed({ upserts: [{ id: memory.id, filename: memory.filename, kind: 'rule', body: 'verified rule' }], remove: [] });
  await assert.rejects(f.service.summarize('alice', PROJECT, event()), { statusCode: 409 });
  await f.service.update('alice', PROJECT, memory.id, { mode: 'auto', version: 1 });
  await f.service.summarize('alice', PROJECT, event());
  const changed = (await f.service.history('alice', PROJECT, memory.id)).memory;
  assert.equal(changed.mode, 'auto');
  assert.equal(changed.title, 'Rules');
  assert.equal(changed.source, 'user', 'origin is not the automatic-edit permission');
  assert.equal(changed.body, 'verified rule');
  const input = JSON.parse(f.calls.at(-1)!.input[0].content);
  assert.equal(input.memory[0].mode, 'auto');
  await f.service.update('alice', PROJECT, memory.id, { mode: 'manual', version: changed.version });
  await assert.rejects(f.service.summarize('alice', PROJECT, event(2)), { statusCode: 409 });
  await assert.rejects(f.service.update('alice', PROJECT, memory.id, { mode: 'bad', version: changed.version + 1 }), { statusCode: 400 });
});

test('invalidated files cannot be revived by the model even when automatic maintenance is enabled', async t => {
  const f = await fixture(t);
  const { memory } = await f.service.create('alice', PROJECT, { kind: 'fact', body: 'old', mode: 'auto' });
  await f.service.update('alice', PROJECT, memory.id, { version: 1, state: 'invalidated', mode: 'auto' });
  f.response.make = async () => completed({ upserts: [{ id: memory.id, filename: memory.filename, kind: 'fact', body: 'revived' }], remove: [] });
  await assert.rejects(f.service.summarize('alice', PROJECT, event()), { statusCode: 409 });
  const input = JSON.parse(f.calls[0].input[0].content);
  assert.equal(input.memory[0].omitted, true);
  assert.equal(input.memory[0].body, undefined);
});
