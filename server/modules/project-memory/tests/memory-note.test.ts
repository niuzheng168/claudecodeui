import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { ErrorRequestHandler } from 'express';
import Database from 'better-sqlite3';

import { ProjectMemoryService } from '../services/project-memory.service.js';
import { createProjectMemoryRoutes } from '../project-memory.routes.js';

const PROJECT = `p-${'a'.repeat(16)}`, OTHER = `p-${'b'.repeat(16)}`;
const fresh = (body = '生产环境使用 PostgreSQL。') => ({ id: null, kind: 'environment', title: '生产数据库', body });
const completed = (value: unknown) => new Response(JSON.stringify({
  status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
}));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codey-note-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Record<string, any>[] = [];
  const response = { make: async () => completed({ changes: [fresh()] }) };
  const dependencies = {
    root, environment: {} as NodeJS.ProcessEnv,
    modelEndpoint: () => ({ url: 'http://127.0.0.1:4141/responses', headers: { authorization: 'Bearer fixture' } }),
    fetch: (async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return response.make(); }) as typeof fetch,
  };
  const directory = path.join(root, 'alice', 'projects', PROJECT, 'memory');
  return { root, directory, calls, response, dependencies, service: new ProjectMemoryService(dependencies) };
}

test('a note previews without writing knowledge, then confirms atomically as manual user memory and replays after restart', async t => {
  const f = await fixture(t);
  const before = await f.service.list('alice', PROJECT);
  const preview = await f.service.previewNote('alice', PROJECT, { text: '生产环境使用 PostgreSQL' });
  assert.match(preview.draftId!, /^[a-f0-9]{32}$/);
  assert.equal(preview.changes[0].action, 'create');
  assert.deepEqual(await f.service.list('alice', PROJECT), before);
  assert.equal((await readdir(f.directory)).includes('topics'), false);
  assert.equal(f.calls[0].model, 'gpt-6.1-terra');
  assert.equal(f.calls[0].store, false);
  assert.deepEqual(f.calls[0].tools, []);
  const restarted = new ProjectMemoryService(f.dependencies);
  assert.deepEqual(await restarted.confirmNote('alice', PROJECT, { draftId: preview.draftId }), { saved: true, replayed: false });
  const saved = await restarted.list('alice', PROJECT);
  assert.equal(saved.memory.length, 1);
  const memory = saved.memory[0];
  assert.deepEqual([memory.filename, memory.mode, memory.source, memory.state], ['生产数据库.md', 'manual', 'user', 'adopted']);
  const replay = await Promise.all([f.service, restarted].map(service => service.confirmNote('alice', PROJECT, { draftId: preview.draftId })));
  assert.ok(replay.every(result => result.replayed));
  assert.deepEqual(await restarted.list('alice', PROJECT), saved, 'retries do not create files, histories or revisions');
  assert.equal((await restarted.history('alice', PROJECT, memory.id)).history[0].changedBy, 'user');
  assert.equal(f.calls.length, 1, 'confirmation never calls the model');
});

test('explicit confirmation can merge protected knowledge but preserves its old content until confirmed', async t => {
  const f = await fixture(t);
  const old = (await f.service.create('alice', PROJECT, { kind: 'rule', title: '部署', body: '先跑测试。', filename: 'deploy.md' })).memory;
  f.response.make = async () => completed({ changes: [{ id: old.id, version: 1, kind: 'decision', title: '部署', body: '先跑测试。\n只在维护窗口发布。' }] });
  const preview = await f.service.previewNote('alice', PROJECT, { text: '部署只在维护窗口进行' });
  assert.equal(preview.changes[0].previous?.body, old.body);
  assert.equal(preview.changes[0].kind, 'decision');
  assert.equal((await f.service.history('alice', PROJECT, old.id)).memory.body, old.body);
  await f.service.confirmNote('alice', PROJECT, { draftId: preview.draftId });
  const history = await f.service.history('alice', PROJECT, old.id);
  assert.equal(history.memory.kind, 'rule', 'legacy rule semantics survive the three-category UI');
  assert.equal(history.memory.mode, 'manual');
  assert.equal(history.memory.filename, 'deploy.md');
  assert.deepEqual(history.history.map(entry => entry.body), ['先跑测试。\n只在维护窗口发布。', old.body]);
});

test('draft ownership, project binding, payload integrity and expiry are enforced', async t => {
  const f = await fixture(t);
  const preview = await f.service.previewNote('alice', PROJECT, { text: '记住生产数据库' });
  for (const [owner, project] of [['bob', PROJECT], ['alice', OTHER]]) {
    await assert.rejects(f.service.confirmNote(owner, project, { draftId: preview.draftId }), { statusCode: 404 });
  }
  await assert.rejects(f.service.confirmNote('alice', PROJECT, { draftId: preview.draftId, changes: [fresh('tampered')] }), { statusCode: 400 });
  const db = new Database(path.join(f.directory, 'index.sqlite'));
  db.prepare('UPDATE note_drafts SET expires_at=0').run();
  db.close();
  await assert.rejects(f.service.confirmNote('alice', PROJECT, { draftId: preview.draftId }), { statusCode: 409 });
  assert.equal((await f.service.list('alice', PROJECT)).memory.length, 0);
});

test('manual edits, deletion and a second confirmed draft fence stale previews without partial changes', async t => {
  const f = await fixture(t);
  const a = await f.service.previewNote('alice', PROJECT, { text: '生产数据库' });
  const b = await f.service.previewNote('alice', PROJECT, { text: '生产数据库' });
  await f.service.confirmNote('alice', PROJECT, { draftId: a.draftId });
  await assert.rejects(f.service.confirmNote('alice', PROJECT, { draftId: b.draftId }), { statusCode: 409 });
  const old = (await f.service.list('alice', PROJECT)).memory[0];
  f.response.make = async () => completed({ changes: [{ ...fresh(), id: old.id, version: old.version, body: '模型建议' }, fresh('另一主题')] });
  const draft = await f.service.previewNote('alice', PROJECT, { text: '生产数据库升级' });
  await f.service.update('alice', PROJECT, old.id, { version: old.version, body: '人工更新胜出' });
  await assert.rejects(f.service.confirmNote('alice', PROJECT, { draftId: draft.draftId }), { statusCode: 409 });
  assert.deepEqual((await f.service.list('alice', PROJECT)).memory.map(memory => memory.body), ['人工更新胜出']);
  await f.service.remove('alice', PROJECT);
  await assert.rejects(f.service.confirmNote('alice', PROJECT, { draftId: draft.draftId }), { statusCode: 404 });
});

test('bad model results, attempted deletion, unsupported kinds and credentials never write knowledge', async t => {
  const f = await fixture(t);
  for (const value of [
    { changes: [fresh()], remove: ['anything'] }, { changes: [fresh(), fresh()] },
    { changes: [{ ...fresh(), kind: 'link' }] }, { changes: [{ ...fresh(), mode: 'auto' }] },
    { changes: [{ ...fresh(), id: `m-${'d'.repeat(16)}`, version: 1 }] },
    { changes: [fresh(), { ...fresh(), title: '' }] },
    { changes: [fresh(`sk-${'a'.repeat(40)}`)] },
    { changes: Array.from({ length: 7 }, (_, index) => fresh(String(index))) },
  ]) {
    f.response.make = async () => completed(value);
    await assert.rejects(f.service.previewNote('alice', PROJECT, { text: '生产数据库' }));
    assert.equal((await f.service.list('alice', PROJECT)).memory.length, 0);
  }
  const count = f.calls.length;
  for (const text of ['', 'x'.repeat(8193), `sk-${'a'.repeat(40)}`]) {
    await assert.rejects(f.service.previewNote('alice', PROJECT, { text }));
  }
  assert.equal(f.calls.length, count);
  f.response.make = async () => new Response('offline', { status: 503 });
  await assert.rejects(f.service.previewNote('alice', PROJECT, { text: '生产数据库' }), { statusCode: 503 });
  f.response.make = async () => completed({ changes: [] });
  assert.equal((await f.service.previewNote('alice', PROJECT, { text: '生产数据库' })).draftId, null);
});

test('large context excerpts cannot be used to replace a full existing file', async t => {
  const f = await fixture(t);
  const old = (await f.service.create('alice', PROJECT, { kind: 'environment', title: '生产数据库', body: '数据库约定。'.repeat(4000) })).memory;
  f.response.make = async () => completed({ changes: [{ ...fresh('truncated replacement'), id: old.id, version: 1 }] });
  await assert.rejects(f.service.previewNote('alice', PROJECT, { text: '生产数据库' }), { statusCode: 409 });
  const material = JSON.parse(f.calls[0].input[0].content);
  assert.equal(material.memory[0].excerpt, true);
  assert.equal((await f.service.history('alice', PROJECT, old.id)).memory.body, old.body);
});

test('model work runs outside the writer lock; concurrent edits win and duplicate preparation is bounded', async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.response.make = async () => { entered(); await waiting; return completed({ changes: [fresh()] }); };
  const preview = f.service.previewNote('alice', PROJECT, { text: '生产数据库' });
  await started;
  await assert.rejects(f.service.previewNote('alice', PROJECT, { text: 'again' }), { statusCode: 409 });
  await f.service.create('alice', PROJECT, { kind: 'decision', body: '同时的人工编辑' });
  release();
  await assert.rejects(preview, { statusCode: 409 });
  assert.equal((await f.service.list('alice', PROJECT)).memory.length, 1);
});

test('confirmation remains atomic when quota rejects the batch, and automatic jobs still cannot overwrite the saved note', async t => {
  const f = await fixture(t);
  f.dependencies.environment.CODEY_MEMORY_QUOTA_BYTES = '65536';
  f.response.make = async () => completed({ changes: [fresh('x'.repeat(40000)), { ...fresh('y'.repeat(40000)), title: '另一主题' }] });
  const draft = await f.service.previewNote('alice', PROJECT, { text: '保存两条环境说明' });
  await assert.rejects(f.service.confirmNote('alice', PROJECT, { draftId: draft.draftId }), { statusCode: 413 });
  assert.equal((await f.service.list('alice', PROJECT)).memory.length, 0);
  delete f.dependencies.environment.CODEY_MEMORY_QUOTA_BYTES;
  await f.service.confirmNote('alice', PROJECT, { draftId: draft.draftId });
  const note = (await f.service.list('alice', PROJECT)).memory[0];
  f.response.make = async () => completed({ upserts: [{ id: note.id, version: 1, kind: 'environment', body: 'automatic overwrite' }], remove: [] });
  await assert.rejects(f.service.summarize('alice', PROJECT, {
    eventId: 'c'.repeat(64), source: `session:n-${'a'.repeat(24)}/s`, transcript: '生产数据库', outcome: 'completed',
  }), { statusCode: 409 });
});

test('note HTTP routes require owner SSO and verified account identity and advertise additive support', async t => {
  const f = await fixture(t), app = express();
  app.use(express.json());
  app.use('/guarded', createProjectMemoryRoutes(f.service));
  app.use('/missing-account', createProjectMemoryRoutes(f.service, () => true, () => null));
  app.use('/owner', createProjectMemoryRoutes(f.service, () => true, () => 'alice'));
  app.use(((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ error: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const call = (prefix: string, operation: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/${prefix}/projects/${PROJECT}/notes/${operation}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await call('guarded', 'preview', { text: 'production' })).status, 403);
  assert.equal((await call('missing-account', 'preview', { text: 'production' })).status, 403);
  assert.equal(f.calls.length, 0);
  const info = await (await fetch(`http://127.0.0.1:${address.port}/owner/info`)).json() as { contract: number; features: { noteDrafts: boolean } };
  assert.equal(info.contract, 3);
  assert.equal(info.features.noteDrafts, true);
  const preview = await (await call('owner', 'preview', { text: 'production' })).json() as { draftId: string };
  assert.equal((await call('owner', 'confirm', { draftId: preview.draftId })).status, 200);
  assert.equal((await call('owner', 'preview', { text: 'x'.repeat(17000) })).status, 413);
});
