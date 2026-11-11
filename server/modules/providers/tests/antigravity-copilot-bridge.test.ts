import assert from 'node:assert/strict';
import test from 'node:test';

import { startAntigravityCopilotBridge } from '@/modules/providers/list/antigravity/antigravity-copilot-bridge.service.js';

const model = 'gemini-4-carbon';
const stream = (rows: unknown[]) => new Response(rows.map(row => `data: ${JSON.stringify(row)}\r\n\r\n`).join('') + 'data: [DONE]\n\n', {
  headers: { 'Content-Type': 'text/event-stream' },
});
const result = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

test('authenticated loopback adapter streams text/tools/usage and persists opaque reasoning for resume', async t => {
  const requests: Record<string, unknown>[] = [];
  const bridge = await startAntigravityCopilotBridge({ model, effort: 'low', baseUrl: 'http://127.0.0.1:4144', key: 'real-proxy-key',
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:4144/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer real-proxy-key');
      assert.equal(new Headers(init?.headers).has('x-goog-api-key'), false);
      assert.equal(init?.redirect, 'error');
      requests.push(JSON.parse(String(init?.body)));
      return stream([
        result({ content: 'Thinking done.' }),
        result({ tool_calls: [{ index: 0, id: 'call_one', function: { name: 'write_to_file', arguments: '{"path":' } }] }),
        result({ tool_calls: [{ index: 0, function: { arguments: '"hello.txt"}' } }], reasoning_opaque: 'b3BhcXVl' }),
        result({}, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } },
      ]);
    },
  });
  t.after(() => bridge.close());
  const send = async (input: unknown, plain = false) => fetch(`${bridge.credentials.baseUrl}/v1beta/models/${model}:${plain ? 'generateContent' : 'streamGenerateContent'}?alt=sse`, {
    method: 'POST', headers: { 'x-goog-api-key': bridge.credentials.apiKey }, body: JSON.stringify(input),
  });
  const body = {
    systemInstruction: { parts: [{ text: 'system rules' }] },
    contents: [{ role: 'user', parts: [{ text: 'write a file' }] }],
    tools: [{ functionDeclarations: [{ name: 'write_to_file', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } }] }],
  };
  const response = await send(body);
  assert.equal(response.status, 200);
  const rows = (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
  assert.equal(rows[0].candidates[0].content.parts[0].text, 'Thinking done.');
  const last = rows.at(-1);
  assert.equal(last.usageMetadata.totalTokenCount, 50);
  assert.deepEqual(last.candidates[0].content.parts, [
    { thought: true, text: '', thoughtSignature: 'b3BhcXVl' },
    { functionCall: { name: 'write_to_file', args: { path: 'hello.txt' }, id: 'call_one' } },
  ]);
  assert.equal(requests[0].model, model);
  assert.equal(requests[0].reasoning_effort, 'low');
  const plain = await send({ ...body, contents: [...body.contents,
    last.candidates[0].content, { role: 'user', parts: [{ functionResponse: { name: 'write_to_file', response: { result: 'done' } } }] }] }, true);
  assert.equal(plain.status, 200);
  const plainBody = await plain.json() as { candidates: { content: { parts: { text?: string }[] } }[] };
  assert.ok(plainBody.candidates[0].content.parts.some(p => p.text === 'Thinking done.'));
  const history = requests[1].messages as { role: string; reasoning_opaque?: string; tool_call_id?: string }[];
  assert.equal(history.find(message => message.role === 'assistant')?.reasoning_opaque, 'b3BhcXVl');
  assert.equal(history.at(-1)?.tool_call_id, 'call_one');
});

test('adapter rejects unauthenticated, wrong-model, malformed and remote-media requests before forwarding', async t => {
  let calls = 0;
  const bridge = await startAntigravityCopilotBridge({ model, baseUrl: 'https://gateway.invalid', key: 'secret', fetch: async () => {
    calls++; return stream([result({ content: 'ok' }, 'stop')]);
  } });
  t.after(() => bridge.close());
  const path = `/v1beta/models/${model}:streamGenerateContent`;
  for (const [pathname, key, body, expected] of [
    [path, '', '{}', 401], [path, 'wrong-key', '{}', 401],
    ['/v1beta/models/gpt-other:streamGenerateContent', bridge.credentials.apiKey, '{}', 404],
    [path, bridge.credentials.apiKey, 'not json', 502],
    [path, bridge.credentials.apiKey, JSON.stringify({ contents: [{ parts: [{ fileData: { fileUri: 'http://169.254.169.254' } }] }] }), 502],
    [path, bridge.credentials.apiKey, JSON.stringify({ contents: [{ parts: [{ functionResponse: { name: 'orphan' } }] }] }), 502],
  ] as const) {
    const r = await fetch(bridge.credentials.baseUrl + pathname, { method: 'POST', headers: { 'x-goog-api-key': key }, body });
    assert.equal(r.status, expected);
    await r.text();
  }
  assert.equal(calls, 0);
});

test('proxy errors are redacted; a truncated stream is not a successful Gemini response', async t => {
  for (const response of [new Response('secret key and user prompt', { status: 403 }), stream([result({ content: 'unfinished' })])]) {
    const bridge = await startAntigravityCopilotBridge({ model, baseUrl: 'https://gateway.invalid', key: 'secret', fetch: async () => response });
    t.after(() => bridge.close());
    const r = await fetch(`${bridge.credentials.baseUrl}/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': bridge.credentials.apiKey }, body: '{}',
    });
    assert.ok([403, 502].includes(r.status));
    assert.doesNotMatch(await r.text(), /secret key|user prompt/);
  }
});

test('closing the per-turn adapter aborts in-flight model requests and is idempotent', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const bridge = await startAntigravityCopilotBridge({ model, baseUrl: 'https://gateway.invalid', key: 'secret',
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      started();
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }),
  });
  const sending = fetch(`${bridge.credentials.baseUrl}/v1beta/models/${model}:streamGenerateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': bridge.credentials.apiKey }, body: '{}',
  }).catch(() => undefined);
  await ready;
  await bridge.close();
  await bridge.close();
  await sending;
  assert.equal(aborted, true);
  await assert.rejects(fetch(bridge.credentials.baseUrl));
});
