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
  app.use('/missing-account', createAzureDevOpsRoutes(service, () => true, () => null));
  app.use('/test', createAzureDevOpsRoutes(service, () => true, () => 'alice'));
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
  assert.equal((await post('missing-account', target)).status, 403);
  for (const input of [
    null, {}, { ...target, token: 'bad' }, { ...target, project: '../other' }, { ...target, organization: 'example.org/other' },
    { ...target, kind: 'write' }, { ...target, kind: 'item', id: '2147483648' }, { ...target, id: '123' },
  ]) assert.equal((await post('test', input)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post('test', target)).status, 200);
  assert.equal(calls, 1);
});
