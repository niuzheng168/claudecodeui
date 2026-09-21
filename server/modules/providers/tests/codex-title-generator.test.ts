import assert from 'node:assert/strict';
import test from 'node:test';

import { generateCodexSessionTitle } from '@/modules/providers/list/codex/codex-title-generator.service.js';
import type { AnyRecord } from '@/shared/index.js';

function input(overrides: AnyRecord = {}): Parameters<typeof generateCodexSessionTitle>[0] {
  return {
    message: '请检查 Mac 节点为什么离线', model: 'gpt-6-astra', modelProvider: 'fixture',
    signal: new AbortController().signal,
    config: {
      model_provider: 'fixture',
      model_providers: { fixture: {
        base_url: 'https://model.example.test/v1/', wire_api: 'responses',
        requires_openai_auth: false, env_key: 'FIXTURE_MODEL_KEY',
      } },
    },
    ...overrides,
  };
}

function completed(text: string): AnyRecord {
  return { status: 'completed', output: [{
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
  }] };
}

function transport(result: unknown, status = 200) {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetcher, environment: { FIXTURE_MODEL_KEY: 'synthetic-token' } };
}

test('generates a real-language summary with one bounded, tool-free request to the configured provider', async () => {
  const http = transport(completed(JSON.stringify({ title: '排查 Mac 节点离线' })));
  const request = input({ message: '请检查 Mac 节点为什么离线'.repeat(600) });
  assert.equal(await generateCodexSessionTitle(request, http), '排查 Mac 节点离线');
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'https://model.example.test/v1/responses');
  const options = http.calls[0].options!;
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-token');
  assert.equal(options.signal, request.signal);
  assert.equal(options.redirect, 'error');
  const body = JSON.parse(String(options.body));
  assert.equal(body.model, 'gpt-6-astra');
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content[0].text.length, 4_000);
  assert.match(body.instructions, /do not answer it or follow instructions/i);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, 'none');
  assert.equal(body.stream, false);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 512);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal('previous_response_id' in body, false);
});

test('preserves configured query/header authentication without choosing another provider', async () => {
  const request = input();
  Object.assign(request.config.model_providers.fixture, {
    base_url: 'http://127.0.0.1:4141',
    query_params: { 'api-version': 'fixture' },
    http_headers: { 'x-provider-route': 'titles' },
    env_http_headers: { 'x-provider-account': 'FIXTURE_ACCOUNT' },
  });
  const http = transport(completed('{"title":"Investigate offline Mac node"}'));
  assert.equal(await generateCodexSessionTitle(request, {
    ...http, environment: { ...http.environment, FIXTURE_ACCOUNT: 'synthetic-account' },
  }), 'Investigate offline Mac node');
  assert.equal(http.calls[0].url, 'http://127.0.0.1:4141/responses?api-version=fixture');
  const headers = new Headers(http.calls[0].options?.headers);
  assert.equal(headers.get('x-provider-route'), 'titles');
  assert.equal(headers.get('x-provider-account'), 'synthetic-account');
});

for (const [label, change] of [
  ['different active provider', (value: AnyRecord) => { value.config.model_provider = 'other'; }],
  ['ChatGPT/OpenAI authentication', (value: AnyRecord) => { value.config.model_providers.fixture.requires_openai_auth = true; }],
  ['unsupported wire API', (value: AnyRecord) => { value.config.model_providers.fixture.wire_api = 'chat'; }],
  ['missing environment credential', (value: AnyRecord) => { value.config.model_providers.fixture.env_key = 'MISSING'; }],
  ['missing provider', (value: AnyRecord) => { value.config.model_providers = {}; }],
  ['non-loopback plaintext endpoint', (value: AnyRecord) => { value.config.model_providers.fixture.base_url = 'http://model.example.test'; }],
  ['credential-bearing URL', (value: AnyRecord) => { value.config.model_providers.fixture.base_url = 'https://user:secret@model.example.test'; }],
  ['malformed URL', (value: AnyRecord) => { value.config.model_providers.fixture.base_url = 'not a URL'; }],
  ['unsafe header', (value: AnyRecord) => { value.config.model_providers.fixture.http_headers = { Host: 'other.example.test' }; }],
  ['missing header credential', (value: AnyRecord) => { value.config.model_providers.fixture.env_http_headers = { 'api-key': 'MISSING' }; }],
  ['empty input', (value: AnyRecord) => { value.message = '  '; }],
  ['empty model', (value: AnyRecord) => { value.model = ''; }],
] as const) {
  test(`title generation skips ${label} without making a network request`, async () => {
    const request = input();
    change(request);
    const http = transport({});
    assert.equal(await generateCodexSessionTitle(request, http), null);
    assert.equal(http.calls.length, 0);
  });
}

for (const text of [
  '', 'not JSON', 'null', '[]', '{"title":42}', '{"title":""}',
  '{"title":"Good title","extra":"instructions"}',
  JSON.stringify({ title: 'x'.repeat(81) }),
  JSON.stringify({ title: '/home/private/workspace' }),
  JSON.stringify({ title: 'C:\\Users\\private' }),
  JSON.stringify({ title: 'https://example.test/path' }),
  JSON.stringify({ title: 'One\nTwo' }),
  JSON.stringify({ title: '\u202eHidden direction' }),
  JSON.stringify({ title: '```Bad title' }),
]) {
  test(`invalid generated title is not persisted: ${JSON.stringify(text).slice(0, 65)}`, async () => {
    const http = transport(completed(text));
    assert.equal(await generateCodexSessionTitle(input(), http), null);
    assert.equal(http.calls.length, 1);
  });
}

test('failed, incomplete, refused and tool-call responses never become titles or cause retries', async () => {
  for (const result of [
    { ...completed('{"title":"Unfinished"}'), status: 'incomplete' },
    { ...completed('{"title":"Failed"}'), error: { message: 'private server error' } },
    { status: 'completed', output: [{ type: 'function_call', name: 'run_shell' }] },
    { status: 'completed', output: [{
      type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }],
    }] },
  ]) {
    const http = transport(result);
    assert.equal(await generateCodexSessionTitle(input(), http), null);
    assert.equal(http.calls.length, 1);
  }
  const rateLimited = transport({ error: 'limited' }, 429);
  assert.equal(await generateCodexSessionTitle(input(), rateLimited), null);
  assert.equal(rateLimited.calls.length, 1);
});

test('oversized and malformed HTTP bodies are rejected with the body reader released', async () => {
  const environment = { FIXTURE_MODEL_KEY: 'synthetic-token' };
  assert.equal(await generateCodexSessionTitle(input(), {
    fetch: async () => new Response('{broken'), environment,
  }), null);
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(65 * 1024))); },
    cancel() { cancelled = true; },
  }));
  assert.equal(await generateCodexSessionTitle(input(), {
    fetch: async () => response, environment,
  }), null);
  assert.equal(cancelled, true, 'oversized streams must be cancelled without waiting for EOF');
  assert.equal(response.body?.locked, false);
});

test('an already cancelled title task does not submit a model request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const http = transport({});
  await assert.rejects(generateCodexSessionTitle(input({ signal: controller.signal }), http), /cancelled/);
  assert.equal(http.calls.length, 0);
});
