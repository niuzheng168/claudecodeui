import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityProviderAuth } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';
import { AntigravityProviderModels } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import { readAntigravityCredentials } from '@/modules/providers/list/antigravity/antigravity-settings.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { antigravitySessionStore } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';

test('Google catalog exposes actual Gemini API IDs and separate thinking levels', async () => {
  const adapter = new AntigravityProviderModels();
  const models = await adapter.getSupportedModels();
  assert.deepEqual(models.OPTIONS.map(model => model.value),
    ['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash']);
  assert.equal(models.DEFAULT, 'gemini-4-carbon');
  assert.equal(providerCapabilitiesService.getProviderCapabilities('antigravity').supportsPermissionRequests, true);
  models.OPTIONS.splice(0, 1);
  assert.equal((await adapter.getSupportedModels()).OPTIONS.length, 3);
});

test('Google credential configuration is node-local, validates endpoints and never leaks keys in status', async () => {
  const previous = { ...process.env };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antigravity-auth-'));
  process.env.CODEY_ANTIGRAVITY_CONFIG = path.join(directory, 'config.json');
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  delete process.env.CODEY_ANTIGRAVITY_BASE_URL;
  const auth = new AntigravityProviderAuth();
  auth.checkInstalled = () => ({ installed: true, version: '0.1.23', exitCode: 0 });
  try {
    assert.equal((await auth.getStatus()).authenticated, false);
    await writeFile(process.env.CODEY_ANTIGRAVITY_CONFIG, '{"apiKey":"private-test-key"}');
    const status = await auth.getStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'gemini_api_key');
    assert.equal(JSON.stringify(status).includes('private-test-key'), false);
    process.env.GEMINI_API_KEY = 'environment-wins';
    assert.equal(readAntigravityCredentials().apiKey, 'environment-wins');
    process.env.CODEY_ANTIGRAVITY_BASE_URL = 'file:///private';
    assert.throws(readAntigravityCredentials, /HTTP/);
    delete process.env.CODEY_ANTIGRAVITY_BASE_URL;
    await writeFile(process.env.CODEY_ANTIGRAVITY_CONFIG, 'not json');
    assert.match((await auth.getStatus()).error!, /configuration/);
    auth.checkInstalled = () => ({ installed: false, version: null, exitCode: null });
    await writeFile(process.env.CODEY_ANTIGRAVITY_CONFIG, '{}');
    assert.match((await auth.getStatus()).error!, /antigravity install/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test('Google history cannot escape its private store using a session ID', () => {
  for (const id of ['../credentials', '/tmp/elsewhere', 'not-a-uuid']) {
    assert.throws(() => antigravitySessionStore.directory(id), /conversation ID/);
  }
});
