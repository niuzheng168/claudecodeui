import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeContextLaunch,
  createCodeyClaudeGateway,
} from '@/modules/providers/services/codey-claude-gateway.service.js';

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
    capabilities: {
      supports: { reasoning_effort: ['low', 'high', 'max', 'ultra', 'high', 10] },
      limits: { max_context_window_tokens: 1_000_000 },
    },
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
  assert.equal(models.OPTIONS[0].label, 'Claude Opus 5.5 (1M context)');
  assert.deepEqual(models.OPTIONS[0].effort, {
    default: 'max', values: ['low', 'high', 'max'].map(value => ({ value })),
  });
  assert.equal(models.OPTIONS[0].contextWindow, 1_000_000);
});

test('the default effort is the highest of max, xhigh and high the model offers', async () => {
  const data = [
    ['low', 'medium', 'high', 'xhigh', 'max'], ['low', 'high', 'xhigh'], ['high', 'medium'], ['medium', 'low'],
  ].map((efforts, index) => ({
    id: `claude-${index}`, supported_endpoints: ['/v1/messages'],
    capabilities: { supports: { reasoning_effort: efforts } },
  }));
  const models = await gateway(managed, (async () => Response.json({ data })) as typeof fetch).getModels();
  assert.deepEqual(models.OPTIONS.map(option => option.effort?.default), ['max', 'xhigh', 'high', 'medium']);
});

test('only a positive integer catalog window is reported', async () => {
  const data = [1_000_000, '1000000', -1, 1.5, null].map((value, index) => ({
    id: `claude-${index}`, supported_endpoints: ['/v1/messages'],
    capabilities: { limits: { max_context_window_tokens: value } },
  }));
  const models = await gateway(managed, (async () => Response.json({ data })) as typeof fetch).getModels();
  assert.deepEqual(models.OPTIONS.map(option => option.contextWindow), [1_000_000, undefined, undefined, undefined, undefined]);
  assert.deepEqual(models.OPTIONS.map(option => option.label), [
    'claude-0 (1M context)', 'claude-1', 'claude-2', 'claude-3', 'claude-4',
  ]);
});

test('picker labels show the catalog window like the Codex catalog', async () => {
  const data = [922_000, 1_500_000, 200_000].map((value, index) => ({
    id: `claude-${index}`, name: `Claude ${index}`, supported_endpoints: ['/v1/messages'],
    capabilities: { limits: { max_context_window_tokens: value } },
  }));
  const models = await gateway(managed, (async () => Response.json({ data })) as typeof fetch).getModels();
  assert.deepEqual(models.OPTIONS.map(option => option.label), [
    'Claude 0 (922K context)', 'Claude 1 (1.5M context)', 'Claude 2 (200K context)',
  ]);
});

test('usage readers share one catalog read and reuse its windows', async () => {
  let reads = 0;
  const fetch = (async () => {
    reads += 1;
    return Response.json({ data: [{
      id: 'claude-opus-5.5', supported_endpoints: ['/v1/messages'],
      capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    }] });
  }) as typeof globalThis.fetch;
  const managedGateway = gateway(managed, fetch);
  assert.deepEqual(await Promise.all([
    managedGateway.getContextWindow('claude-opus-5.5'),
    managedGateway.getContextWindow('claude-opus-5.5'),
  ]), [1_000_000, 1_000_000]);
  assert.equal(await managedGateway.getContextWindow('claude-unlisted'), undefined);
  assert.equal(reads, 1);
  assert.equal(await gateway({}, fetch).getContextWindow('claude-opus-5.5'), undefined);
  assert.equal(await gateway(managed, (async () => { throw new Error('down'); }) as typeof fetch)
    .getContextWindow('claude-opus-5.5'), undefined);
  assert.equal(reads, 1);
});

test('a catalog window above Claude Code\'s default selects 1M and compacts at 60%', () => {
  const env = { PATH: 'host-path' };
  const launch = buildClaudeContextLaunch('claude-opus-5.5', 1_000_000, env);
  assert.equal(launch.model, 'claude-opus-5.5[1m]');
  // Claude Code compacts 33K below this window: at 600K, 60% of 1M.
  assert.equal(launch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '633000');
  assert.equal(launch.env.PATH, 'host-path');
  assert.deepEqual(env, { PATH: 'host-path' });
  assert.equal(buildClaudeContextLaunch('claude-opus-5.5[1m]', 1_000_000, env).model, 'claude-opus-5.5[1m]');
});

test('standard and small windows keep their model id and compact inside the window', () => {
  const standard = buildClaudeContextLaunch('claude-sonnet-5', 200_000, {});
  assert.equal(standard.model, 'claude-sonnet-5');
  assert.equal(standard.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '153000');
  assert.equal(buildClaudeContextLaunch('claude-small', 120_000, {}).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '105000');
  assert.equal(buildClaudeContextLaunch('claude-tiny', 64_000, {}).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '64000');
});

test('an explicit compaction window is never overridden', () => {
  const launch = buildClaudeContextLaunch('claude-opus-5.5', 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' });
  assert.equal(launch.model, 'claude-opus-5.5[1m]');
  assert.equal(launch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
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
