import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodeyClaudeGateway } from '@/modules/providers/services/codey-claude-gateway.service.js';

const managed = { CODEY_MANAGED: 'true', CODEY_MODEL_API_KEY: 'private-test-key' };
const gateway = (environment: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch) => (
  createCodeyClaudeGateway({ environment: () => environment, fetch })
);

test('ordinary Claude auth environment is unchanged and copied', () => {
  const env = { ANTHROPIC_API_KEY: 'existing', ANTHROPIC_BASE_URL: 'https://original.test' };
  const result = gateway(env).buildEnvironment();
  assert.deepEqual(result, env);
  assert.notEqual(result, env);
});

test('managed child uses Codey API without changing host credentials', () => {
  const env = {
    ...managed, PATH: 'host-path', ANTHROPIC_API_KEY: 'other',
    CLAUDE_CODE_OAUTH_TOKEN: 'other-oauth', CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
  };
  const original = { ...env };
  const result = gateway(env).buildEnvironment();
  assert.equal(result.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4141');
  assert.equal(result.ANTHROPIC_AUTH_TOKEN, managed.CODEY_MODEL_API_KEY);
  assert.equal(result.ANTHROPIC_API_KEY, '');
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.equal(result.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.equal(result.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(result.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.equal(result.PATH, env.PATH);
  assert.deepEqual(env, original);
});

test('managed auth fails closed instead of using personal Claude credentials', () => {
  assert.throws(() => gateway({
    CODEY_MANAGED: 'true', ANTHROPIC_API_KEY: 'personal',
  }).buildEnvironment(), /not configured/);
});

test('endpoint supports independent HTTPS and loopback APIs, never plaintext remote credentials', () => {
  for (const url of ['https://gateway.test/base', 'http://[::1]:4141', 'http://localhost:4141/']) {
    assert.equal(gateway({ ...managed, CODEY_MODEL_BASE_URL: url })
      .buildEnvironment().ANTHROPIC_BASE_URL, url.replace(/\/$/, ''));
  }
  for (const url of ['http://external.test', 'https://user:secret@gateway.test', 'invalid', 'https://gateway.test/?secret=x']) {
    assert.throws(() => gateway({ ...managed, CODEY_MODEL_BASE_URL: url }).buildEnvironment(), /HTTPS or loopback/);
  }
});

test('catalog retains exact gateway model IDs and native Messages capabilities', async () => {
  const model = {
    id: 'loki/claude-opus-5.5', name: 'Claude Opus 5.5',
    supported_endpoints: ['/v1/messages'],
    capabilities: { supports: { reasoning_effort: ['low', 'high', 'max', 'ultra', 'high', 10] } },
  };
  const fetch = (async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:4141/models');
    assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer private-test-key');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ data: [
      model, model, null, { id: 'gpt-6.1-sol', supported_endpoints: ['/responses'] },
      { id: 'claude-other', supported_endpoints: ['/responses'] },
      { id: 'claude-unavailable' },
    ] });
  }) as typeof globalThis.fetch;
  const models = await gateway(managed, fetch).getModels();
  assert.equal(models.DEFAULT, model.id);
  assert.equal(models.modelApiManaged, true);
  assert.deepEqual(models.OPTIONS.map(option => option.value), [model.id]);
  assert.equal(models.OPTIONS[0].label, model.name);
  assert.deepEqual(models.OPTIONS[0].effort, {
    default: 'high', values: ['low', 'high', 'max'].map(value => ({ value })),
  });
});

test('no available Claude model never falls back to public Anthropic or GPT', async () => {
  const result = await gateway(managed, (async () => Response.json({ data: [] })) as typeof fetch).getModels();
  assert.deepEqual(result, { DEFAULT: '', OPTIONS: [], modelApiManaged: true });
});

test('untrusted failures cannot disclose upstream response bodies or credentials', async () => {
  for (const fake of [
    async () => { throw new Error('private-test-key'); },
    async () => new Response('private-test-key', { status: 401 }),
    async () => new Response('private-test-key'),
    async () => Response.json({ wrong: 'private-test-key' }),
  ]) {
    await assert.rejects(gateway(managed, fake as typeof fetch).getModels(), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-test-key/);
      return true;
    });
  }
});
