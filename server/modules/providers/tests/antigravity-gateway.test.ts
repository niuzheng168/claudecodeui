import assert from 'node:assert/strict';
import test from 'node:test';

import { createAntigravityGateway } from '@/modules/providers/list/antigravity/antigravity-gateway.service.js';
import { AntigravityProviderAuth } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';
import { AntigravityProviderModels } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';

const row = (id = 'gemini-4-carbon') => ({
  id, name: id, supported_endpoints: ['/chat/completions'],
  capabilities: { supports: { reasoning_effort: ['low', 'medium', 'high'] } },
});
const environment = () => ({
  CODEY_MANAGED: 'true', CODEY_MODEL_API_KEY: 'private-proxy-key', CODEY_MODEL_BASE_URL: 'http://127.0.0.1:4144',
  GEMINI_API_KEY: 'must-not-use', CODEY_ANTIGRAVITY_CONFIG: '/broken/direct-google.json',
});

test('managed Google models and auth come from the proxy, not hardcoded IDs or Google credentials', async () => {
  const gateway = createAntigravityGateway({ environment, fetch: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:4144/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-proxy-key');
    assert.equal(init?.redirect, 'error');
    return Response.json({ data: [row('gemini-3.8-flash'), row(), row(),
      row('gpt-not-google'), { ...row('gemini-disabled'), policy: { state: 'disabled' } },
      { ...row('gemini-responses'), supported_endpoints: ['/responses'] },
      { ...row('gemini-hidden'), model_picker_enabled: false }] });
  } });
  const models = await new AntigravityProviderModels(gateway).getSupportedModels();
  assert.deepEqual(models.OPTIONS.map(model => model.value), ['gemini-4-carbon', 'gemini-3.8-flash']);
  assert.equal(models.modelApiManaged, true);
  const auth = new AntigravityProviderAuth(gateway);
  auth.checkInstalled = () => ({ installed: true, version: '0.1.23', exitCode: 0 });
  const status = await auth.getStatus();
  assert.equal(status.authenticated, true);
  assert.equal(status.method, 'codey_model_api');
  assert.equal(JSON.stringify(status).includes('private-proxy-key'), false);
  await assert.rejects(() => gateway.open('gemini-4-carbon', 'extra_high'), /thinking level/);
  await assert.rejects(() => gateway.open('gemini-absent'), /proxy does not offer/);
});

test('empty, denied and unavailable proxy catalogs never fall back to Google login or static models', async () => {
  for (const response of [Response.json({ data: [] }), new Response('', { status: 401 }),
    Response.json({ unexpected: true }), new Response('private-proxy-key is not JSON')]) {
    const gateway = createAntigravityGateway({ environment, fetch: async () => response.clone() });
    const auth = new AntigravityProviderAuth(gateway);
    auth.checkInstalled = () => ({ installed: true, version: '0.1.23', exitCode: 0 });
    const status = await auth.getStatus();
    assert.equal(status.authenticated, false);
    assert.doesNotMatch(status.error!, /Run codey antigravity login/);
    assert.doesNotMatch(JSON.stringify(status), /private-proxy-key/);
    await assert.rejects(() => gateway.open('gemini-4-carbon'));
  }
});

test('unsafe gateway URLs or missing credentials cannot forward model requests', async () => {
  for (const env of [{ CODEY_MANAGED: 'true' }, ...[
    'http://remote.invalid', 'https://user:pass@example.com', 'https://example.com?token=secret', 'file:///private',
  ].map(url => ({ ...environment(), CODEY_MODEL_BASE_URL: url }))]) {
    const gateway = createAntigravityGateway({ environment: () => env, fetch: async () => {
      throw new Error('Must not fetch an invalid target');
    } });
    await assert.rejects(() => gateway.getModels(), /Codey/);
  }
});
