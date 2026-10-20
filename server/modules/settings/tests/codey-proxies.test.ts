import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';

import express from 'express';

import { createCodeyProxiesService } from '@/modules/settings/codey-proxies.service.js';
import { createCodeyProxiesRouter } from '@/modules/settings/codey-proxies.routes.js';

const environment = { CODEY_MANAGED: 'true', COPILOT_API_HOME: path.join(os.tmpdir(), 'fake-copilot-home') };
const snapshot = {
  enabled: true, settingsFile: '/node/settings.json', revision: 'a'.repeat(64),
  additionalCopilotProxies: [{
    id: 'extra', enabled: true, endpoint: 'https://proxy.example', models: ['claude-opus-5.5'],
    keyConfigured: true,
  }],
};
const readConfig = async () => JSON.stringify({ auth: { adminApiKey: 'private-admin-key' } });

test('node settings use only the loopback admin API and whitelist returned fields', async () => {
  const service = createCodeyProxiesService({
    environment, readConfig,
    fetch: (async (url, options) => {
      assert.equal(String(url), 'http://127.0.0.1:4141/admin/config/codey-settings');
      assert.equal((options?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer private-admin-key');
      assert.equal(options?.redirect, 'error');
      return Response.json({
        ...snapshot, secret: 'private-admin-key',
        additionalCopilotProxies: [{ ...snapshot.additionalCopilotProxies[0], key: 'private-proxy-key' }],
      });
    }) as typeof fetch,
  });
  assert.deepEqual(await service.read(), snapshot);
});

test('saving forwards the versioned document without persisting a second settings copy', async () => {
  const update = { revision: snapshot.revision, additionalCopilotProxies: [] };
  const service = createCodeyProxiesService({
    environment, readConfig,
    fetch: (async (_url, options) => {
      assert.equal(options?.method, 'PUT');
      assert.deepEqual(JSON.parse(String(options?.body)), update);
      return Response.json(snapshot);
    }) as typeof fetch,
  });
  assert.deepEqual(await service.save(update), snapshot);
});

test('admin keys are not sent to configurable or non-loopback inference endpoints', async () => {
  let requests = 0;
  for (const url of ['https://remote.example', 'http://127.0.0.1:4141/?key=x', 'file:///tmp/config', 'http://user:pw@localhost:4141']) {
    const service = createCodeyProxiesService({
      environment: { ...environment, CODEY_GATEWAY_ADMIN_URL: url }, readConfig,
      fetch: (async () => { requests += 1; return Response.json(snapshot); }) as typeof fetch,
    });
    await assert.rejects(service.read(), /configuration is invalid/);
  }
  assert.equal(requests, 0);
});

test('unsupported installations and credential errors fail before making requests', async () => {
  await assert.rejects(createCodeyProxiesService({ environment: {} }).read(), /only in Codey/);
  await assert.rejects(createCodeyProxiesService({ environment: { CODEY_MANAGED: 'true' } }).read(), /configuration is unavailable/);
  await assert.rejects(createCodeyProxiesService({
    environment, readConfig: async () => '{"key":"secret",broken',
  }).read(), /configuration is invalid/);
});

test('gateway failures never reflect key-bearing bodies or exception details', async () => {
  for (const status of [400, 409, 404, 500]) {
    const service = createCodeyProxiesService({
      environment, readConfig,
      fetch: (async () => new Response('private-proxy-key', { status })) as typeof fetch,
    });
    await assert.rejects(service.read(), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-proxy-key/);
      if (status === 409) assert.match(error.message, /Reload/);
      return true;
    });
  }
  const service = createCodeyProxiesService({
    environment, readConfig, fetch: (async () => { throw Error('private-admin-key'); }) as typeof fetch,
  });
  await assert.rejects(service.read(), /local model API is unavailable/);
});

test('only a verified node owner can cause settings reads or writes', async () => {
  let readCount = 0;
  const service = createCodeyProxiesService({
    environment, readConfig: async () => { readCount += 1; return readConfig(); },
  });
  const app = express();
  app.use(express.json());
  app.use('/settings', createCodeyProxiesRouter(service, () => false));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    for (const method of ['GET', 'PUT']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/settings`, {
        method, headers: { 'x-codey-owner': 'true' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(readCount, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
