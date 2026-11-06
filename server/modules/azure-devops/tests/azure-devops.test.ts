import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import type { AzureDevOpsTarget } from '@/shared/index.js';

import { createAzureDevOpsRoutes } from '../azure-devops.routes.js';
import { AzureDevOpsService } from '../services/azure-devops.service.js';

const target: AzureDevOpsTarget = { organization: 'example-org', project: 'Example Project', kind: 'query', id: '11111111-2222-3333-4444-555555555555' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const raw = (id: number) => ({ id, fields: {
  'System.Title': `Item ${id}`, 'System.State': 'New', 'System.WorkItemType': 'Feature',
  'System.TeamProject': 'Example Project', 'System.AssignedTo': { displayName: 'Example User' },
} });

test('tree queries use relation IDs even if workItems is empty, preserve columns/order and hydrate asOf', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const responses = [
    { name: 'Voice Agent' },
    { queryType: 'tree', asOf: '2026-10-31T12:00:00Z', workItems: [], columns: [{ referenceName: 'System.Title', name: 'Title' }],
      workItemRelations: [{ source: null, target: { id: 10 } }, { source: { id: 10 }, target: { id: 11 }, rel: 'System.LinkTypes.Hierarchy-Forward' }] },
    { value: [raw(11), raw(10)] },
  ];
  const service = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return json(responses.shift());
  }) as typeof fetch });
  const result = await service.read(target);
  assert.deepEqual(result.items.map(item => item.id), [10, 11]);
  assert.equal(result.title, 'Voice Agent');
  assert.equal(result.relations[1].sourceId, 10);
  assert.equal(result.items[0].assignedTo, 'Example User');
  assert.equal(result.items[0].values['System.Title'], 'Item 10');
  assert.match(calls[0].url, /^https:\/\/dev.azure.com\/example-org\/Example%20Project\/_apis\/wit\/queries\//);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'GET', 'POST']);
  const batch = JSON.parse(String(calls[2].options.body));
  assert.deepEqual(batch.ids, [10, 11]);
  assert.equal(batch.asOf, '2026-10-31T12:00:00Z');
  assert.equal(JSON.stringify(result).includes('test-only'), false);
});

test('large flat queries batch in groups of 200 and disclose truncation and omitted items', async () => {
  const sizes: number[] = [];
  const service = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async (url, options) => {
    if (String(url).includes('/queries/')) return json({ name: 'All' });
    if (String(url).includes('/wiql/')) return json({ queryType: 'flat', workItems: Array.from({ length: 1001 }, (_, i) => ({ id: i + 1 })) });
    const ids: number[] = JSON.parse(String(options?.body)).ids;
    sizes.push(ids.length);
    return json({ value: ids.filter(id => id !== 2).map(raw) });
  }) as typeof fetch });
  const result = await service.read(target);
  assert.deepEqual(sizes, [200, 200, 200, 200, 200]);
  assert.equal(result.items.length, 999);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.missingIds, [2]);
});

test('empty queries do not make a batch call; direct items return text, not executable descriptions', async () => {
  let calls = 0;
  const empty = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async () => {
    calls++; return json(calls === 1 ? { name: 'Empty' } : { queryType: 'flat', workItems: [] });
  }) as typeof fetch });
  assert.deepEqual((await empty.read(target)).items, []);
  assert.equal(calls, 2);
  const item = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async () => json({
    ...raw(123), fields: { ...raw(123).fields, 'System.Description': '<p>hello &amp; world</p><script>bad()</script><img src=x onerror=bad()>' },
  })) as typeof fetch });
  const result = await item.read({ ...target, kind: 'item', id: '123' });
  assert.equal(result.items[0].description, 'hello & world');
  assert.match(result.items[0].url, /\/_workitems\/edit\/123$/);
});

test('upstream auth, rate-limit, invalid-query and oversized failures never expose bodies or credentials', async () => {
  for (const [status, code] of [[401, 'ADO_FORBIDDEN'], [403, 'ADO_FORBIDDEN'], [404, 'ADO_NOT_FOUND'], [400, 'ADO_QUERY_INVALID'], [429, 'ADO_RATE_LIMIT'], [500, 'ADO_REQUEST_FAILED']] as const) {
    const service = new AzureDevOpsService({ token: async () => 'private-token', fetch: (async () => json({ secret: 'private-body' }, status)) as typeof fetch });
    await assert.rejects(service.read(target), (error: Error & { code?: string }) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
  }
  const failedAuth = new AzureDevOpsService({ token: async () => { throw new Error('private-token'); } });
  await assert.rejects(failedAuth.read(target), (error: Error) => !error.message.includes('private-token'));
  const tooLarge = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async () => json({ text: 'x'.repeat(4 * 1024 * 1024) })) as typeof fetch });
  await assert.rejects(tooLarge.read(target), { code: 'ADO_RESULT_TOO_LARGE' });
});

test('one-hop relations survive normalization and the node bounds concurrent Azure reads', async () => {
  const service = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async url => {
    if (String(url).includes('/queries/')) return json({ name: 'Related' });
    if (String(url).includes('/wiql/')) return json({ queryType: 'oneHop', workItemRelations: [
      { source: { id: 1 }, target: { id: 2 }, rel: 'System.LinkTypes.Related' },
    ] });
    return json({ value: [raw(1), raw(2)] });
  }) as typeof fetch });
  const result = await service.read(target);
  assert.equal(result.queryType, 'oneHop');
  assert.deepEqual(result.relations, [{ sourceId: 1, targetId: 2, rel: 'System.LinkTypes.Related' }]);
  let release!: () => void;
  const waiting = new Promise<string>(resolve => { release = () => resolve('test-only'); });
  const limited = new AzureDevOpsService({ token: () => waiting, fetch: (async () => json(raw(123))) as typeof fetch });
  const reads = Array.from({ length: 4 }, () => limited.read({ ...target, kind: 'item', id: '123' }));
  await assert.rejects(limited.read(target), { code: 'ADO_BUSY', statusCode: 429 });
  release();
  await Promise.all(reads);
  assert.equal((await limited.read({ ...target, kind: 'item', id: '123' })).items.length, 1);
});

test('node routes require verified owner SSO and reject non-target input before invoking the reader', async t => {
  let calls = 0;
  const service = { read: async (_target: AzureDevOpsTarget) => { calls++; return { contract: 1 }; } } as unknown as Pick<AzureDevOpsService, 'read'>;
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/guarded', createAzureDevOpsRoutes(service));
  app.use('/test', createAzureDevOpsRoutes(service, () => true));
  app.use(((error, _req, res, _next) => {
    res.status(error.statusCode ?? 500).json({ code: error.code, error: error.message });
  }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (prefix: string, value: unknown) => fetch(`${base}/${prefix}/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal((await post('guarded', target)).status, 403);
  for (const input of [
    null, {}, { ...target, token: 'bad' }, { ...target, project: '../other' }, { ...target, organization: 'example.org/other' },
    { ...target, kind: 'write' }, { ...target, kind: 'item', id: '2147483648' }, { ...target, id: '123' },
  ]) assert.equal((await post('test', input)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post('test', target)).status, 200);
  assert.equal(calls, 1);
});

const scope = { organization: 'example-org', project: 'Example Project' };
const intakeRaw = (id: number, extra: Record<string, unknown> = {}) => ({ id, rev: 3, fields: {
  ...raw(id).fields, 'System.Tags': 'codey_A; SLA', 'System.AreaPath': 'Example\\Voice', 'System.CreatedBy': { displayName: 'Detector Bot' },
  'System.CreatedDate': '2026-11-05T01:00:00Z', 'System.ChangedDate': '2026-11-05T02:00:00Z', ...extra,
} });

test('items returns metadata only: by ID with the missing ones, or for the first 200 items of a saved query', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const service = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async (url, options) => {
    calls.push({ url: String(url), options: options! });
    if (String(url).includes('/wiql/')) {
      return json({ asOf: '2026-11-05T03:00:00Z', workItems: Array.from({ length: 201 }, (_, i) => ({ id: i + 1 })), workItemRelations: [{ source: null, target: { id: 500 } }] });
    }
    const ids: number[] = JSON.parse(String(options?.body)).ids;
    // `errorPolicy: Omit` answers a missing item with null.
    return json({ value: ids.map(id => id === 404 ? null : intakeRaw(id, { 'System.Description': 'secret text', ...(id === 9 ? { 'System.State': 'Closed' } : {}) })) });
  }) as typeof fetch });
  const byId = await service.items({ ...scope, ids: [7, 9, 404] });
  assert.deepEqual(byId.items.map((item: { id: number; closed: boolean }) => [item.id, item.closed]), [[7, false], [9, true]]);
  assert.deepEqual(byId.missingIds, [404]);
  assert.equal(byId.truncated, false);
  assert.deepEqual(byId.items[0].tags, ['codey_A', 'SLA']);
  assert.equal(byId.items[0].createdBy, 'Detector Bot');
  assert.equal(byId.items[0].rev, 3);
  assert.equal(JSON.stringify(byId).includes('secret text'), false);
  const batch = JSON.parse(String(calls[0].options.body));
  assert.equal(batch.errorPolicy, 'Omit');
  assert.ok(batch.fields.includes('System.Rev'));

  calls.length = 0;
  const byQuery = await service.items({ ...scope, queryId: '11111111-2222-3333-4444-555555555555' });
  assert.match(calls[0].url, /\/wiql\/11111111-2222-3333-4444-555555555555\?\$top=201&/);
  assert.equal(calls[0].options.method, 'GET', 'a saved query is run, not written');
  assert.equal(byQuery.items.length, 200);
  assert.equal(byQuery.truncated, true);
  assert.equal(JSON.parse(String(calls[1].options.body)).asOf, '2026-11-05T03:00:00Z');
});

test('item detail is plain text with the newest comments; missing comments do not fail it', async () => {
  const service = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async url => {
    if (String(url).includes('/comments')) {
      assert.match(String(url), /api-version=7\.1-preview\.4/);
      return json({ comments: [{ createdBy: { displayName: 'Dev' }, createdDate: '2026-11-05T03:00:00Z', text: '<p>Seen on <b>prod</b></p>' }] });
    }
    return json(intakeRaw(7, { 'System.Description': '<div>Timeout &amp; retry</div><script>x()</script>', 'Microsoft.VSTS.TCM.ReproSteps': '<ol><li>Call</li></ol>' }));
  }) as typeof fetch });
  const { item } = await service.item({ ...scope, id: '7' });
  assert.equal(item.description, 'Timeout & retry');
  assert.equal(item.reproSteps, 'Call');
  assert.deepEqual(item.comments, [{ author: 'Dev', at: '2026-11-05T03:00:00Z', text: 'Seen on prod' }]);
  const noComments = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async url =>
    String(url).includes('/comments') ? json({}, 404) : json(intakeRaw(7))) as typeof fetch });
  assert.deepEqual((await noComments.item({ ...scope, id: '7' })).item.comments, []);
});

test('update writes one JSON Patch that tests the revision, edits tags case-insensitively and escapes the comment', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const service = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async (url, options) => {
    calls.push({ url: String(url), options: options! });
    if (options?.method === 'PATCH') return json({ id: 7, rev: 6 });
    return json({ id: 7, rev: 5, fields: { 'System.Tags': 'CODEY_A; SLA', 'System.CreatedBy': { displayName: 'Bot', uniqueName: 'bot@example.test' } } });
  }) as typeof fetch });
  const result = await service.update({ ...scope, id: '7', comment: '[codey] <b>not ours</b>\nsecond line', removeTags: ['codey_A'], addTags: ['codey_rejected'], assignTo: 'creator' });
  assert.deepEqual(result, { contract: 1, id: 7, rev: 6, changed: true });
  const patch = calls[1];
  assert.equal(patch.options.method, 'PATCH');
  assert.equal((patch.options.headers as Record<string, string>)['content-type'], 'application/json-patch+json');
  const operations = JSON.parse(String(patch.options.body));
  assert.deepEqual(operations[0], { op: 'test', path: '/rev', value: 5 });
  assert.deepEqual(operations.find((op: { path: string }) => op.path === '/fields/System.Tags'),
    { op: 'replace', path: '/fields/System.Tags', value: 'SLA; codey_rejected' }, 'ADO merges an add, so removing a tag replaces the list');
  assert.equal(operations.find((op: { path: string }) => op.path === '/fields/System.History').value, '[codey] &lt;b&gt;not ours&lt;/b&gt;<br>second line');
  assert.equal(operations.find((op: { path: string }) => op.path === '/fields/System.AssignedTo').value, 'bot@example.test');
  for (const [status, code] of [[412, 'ADO_CONFLICT'], [409, 'ADO_CONFLICT'], [400, 'ADO_UPDATE_INVALID']] as const) {
    const failing = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async (_url, options) => options?.method === 'PATCH'
      ? json({ message: 'private-body' }, status) : json({ id: 7, rev: 5, fields: {} })) as typeof fetch });
    await assert.rejects(failing.update({ ...scope, id: '7', comment: 'x' }), { code });
  }
  const untagged: RequestInit[] = [];
  const first = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async (_url, options) => {
    untagged.push(options!);
    return options?.method === 'PATCH' ? json({ id: 7, rev: 2 }) : json({ id: 7, rev: 1, fields: {} });
  }) as typeof fetch });
  await first.update({ ...scope, id: '7', addTags: ['codey_B'] });
  assert.equal(JSON.parse(String(untagged[1].body))[1].op, 'add', 'an item without tags gets its first one added');
  const unchanged = new AzureDevOpsService({ token: async () => 'test-only', fetch: (async () => json({ id: 7, rev: 5, fields: { 'System.Tags': 'SLA' } })) as typeof fetch });
  assert.equal((await unchanged.update({ ...scope, id: '7', removeTags: ['codey_A'] })).changed, false);
});

test('items, item, update and triage routes reject unbounded input before touching ADO', async t => {
  const calls: string[] = [];
  const service = {
    items: async () => { calls.push('items'); return { contract: 1, items: [] }; },
    item: async () => { calls.push('item'); return { contract: 1, item: { id: 7, title: 'T', description: 'body', reproSteps: '', comments: [] } }; },
    update: async () => { calls.push('update'); return { contract: 1 }; },
  } as unknown as Pick<AzureDevOpsService, 'items' | 'item' | 'update'>;
  const triage = async () => ({ verdict: 'not_ours' }) as never;
  const app = express();
  app.use(express.json());
  app.use('/test', createAzureDevOpsRoutes(service, () => true, triage));
  app.use(((error, _req, res, _next) => { res.status(error.statusCode ?? 500).json({ code: error.code }); }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/test`;
  const post = (path: string, value: unknown) => fetch(`${base}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.deepEqual(await (await fetch(`${base}/info`)).json(), { contract: 1, features: ['read', 'items', 'item', 'triage', 'update'] });
  for (const [path, input] of [
    ['items', { ...scope, queryId: "x' OR 1=1" }], ['items', { ...scope, ids: [] }], ['items', { ...scope, ids: ['7'] }],
    ['items', { ...scope, ids: Array.from({ length: 201 }, (_, i) => i + 1) }], ['items', { ...scope, ids: [7], queryId: '11111111-2222-3333-4444-555555555555' }],
    ['update', { ...scope, id: '7', addTags: ['a', 'b', 'c', 'd', 'e'] }], ['update', { ...scope, id: '7', assignTo: 'someone' }],
    ['update', { ...scope, id: '7', comment: 'x'.repeat(4001) }], ['update', { ...scope, id: '7', fields: {} }],
    ['triage', { ...scope, id: '7', context: { project: { name: 'P' }, directories: 'nope' } }],
    ['item', { ...scope, id: '0' }],
  ] as const) assert.equal((await post(path, input)).status, 400, JSON.stringify(input));
  assert.deepEqual(calls, []);
  assert.equal((await post('items', { ...scope, ids: [7, 7] })).status, 200);
  assert.equal((await post('update', { ...scope, id: '7', comment: 'ok', assignTo: 'dev@example.test' })).status, 200);
  const triaged = await post('triage', { ...scope, id: '7', context: { project: { name: 'P', description: '' }, directories: [], otherProjects: [], openWorkItems: [] } });
  const body = await triaged.json() as { item: Record<string, unknown>; result: { verdict: string } };
  assert.equal(body.item.description, undefined);
  assert.equal(body.result.verdict, 'not_ours');
  assert.deepEqual(calls, ['items', 'update', 'item']);
});
