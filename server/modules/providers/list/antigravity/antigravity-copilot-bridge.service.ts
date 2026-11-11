import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';

import { readObjectRecord } from '@/shared/index.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => readObjectRecord(value) ?? {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const MAX_BYTES = 16 * 1024 * 1024;

function schema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'propertyOrdering').map(([key, child]) => [
    key, key === 'type' && typeof child === 'string' ? child.toLowerCase() : schema(child),
  ]));
}

function completionRequest(input: Json, model: string, effort?: string): Json {
  const messages: Json[] = [];
  const instructions = array(object(input.systemInstruction).parts).map(p => object(p).text).filter(v => typeof v === 'string').join('\n');
  if (instructions) messages.push({ role: 'system', content: instructions });
  const pending: { id: string; name: string }[] = [];
  let callNumber = 0;
  for (const raw of array(input.contents)) {
    const entry = object(raw);
    const content: Json[] = [], calls: Json[] = [], results: Json[] = [];
    let opaque = '', thinking = '';
    for (const rawPart of array(entry.parts)) {
      const part = object(rawPart);
      if (typeof part.thoughtSignature === 'string') opaque += part.thoughtSignature;
      if (part.thought && typeof part.text === 'string') thinking += part.text;
      if (typeof part.text === 'string' && !part.thought) content.push({ type: 'text', text: part.text });
      if (part.inlineData) {
        const media = object(part.inlineData);
        if (typeof media.mimeType !== 'string' || !media.mimeType.startsWith('image/') || typeof media.data !== 'string') {
          throw new Error('The Copilot bridge currently accepts inline images, not arbitrary inline media.');
        }
        content.push({ type: 'image_url', image_url: { url: `data:${media.mimeType};base64,${media.data}` } });
      }
      if (part.fileData) throw new Error('Remote media URLs are not accepted by the Copilot bridge.');
      if (part.functionCall) {
        const fn = object(part.functionCall);
        if (typeof fn.name !== 'string') throw new Error('Invalid function call.');
        const id = typeof fn.id === 'string' ? fn.id : `call_${callNumber++}`;
        pending.push({ id, name: fn.name });
        calls.push({ id, type: 'function', function: { name: fn.name, arguments: JSON.stringify(fn.args ?? {}) } });
      }
      if (part.functionResponse) {
        const fn = object(part.functionResponse);
        let index = pending.findIndex(call => fn.id && call.id === fn.id);
        if (index < 0) index = pending.findIndex(call => call.name === fn.name);
        if (index < 0) throw new Error('Tool result does not match a preceding function call.');
        const [call] = pending.splice(index, 1);
        results.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(fn.response ?? {}) });
      }
    }
    if (content.length || calls.length) {
      messages.push({ role: entry.role === 'model' ? 'assistant' : 'user',
        content: content.length ? content : null, ...(calls.length ? { tool_calls: calls } : {}),
        ...(entry.role === 'model' && opaque ? { reasoning_opaque: opaque } : {}),
        ...(entry.role === 'model' && thinking ? { reasoning_text: thinking } : {}) });
    }
    messages.push(...results);
  }
  const tools = array(input.tools).flatMap(tool => array(object(tool).functionDeclarations)).map(raw => {
    const fn = object(raw);
    if (typeof fn.name !== 'string') throw new Error('Invalid tool declaration.');
    return { type: 'function', function: { name: fn.name, description: fn.description ?? '',
      parameters: schema(fn.parametersJsonSchema ?? fn.parameters ?? { type: 'object', properties: {} }) } };
  });
  const config = object(input.generationConfig);
  const toolConfig = object(object(input.toolConfig).functionCallingConfig);
  const allowed = array(toolConfig.allowedFunctionNames);
  return {
    model, messages, stream: true, stream_options: { include_usage: true },
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(Number.isInteger(config.maxOutputTokens) && Number(config.maxOutputTokens) > 0
      ? { max_tokens: config.maxOutputTokens } : {}),
    ...(tools.length ? {
      tools: allowed.length ? tools.filter(tool => allowed.includes(tool.function.name)) : tools,
      tool_choice: toolConfig.mode === 'NONE' ? 'none' : toolConfig.mode === 'ANY' ? 'required' : 'auto',
    } : {}),
  };
}

async function* sse(response: Response): AsyncGenerator<Json> {
  if (!response.body) throw new Error('Empty Copilot stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = '';
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length + data.length > MAX_BYTES) throw new Error('Copilot stream event exceeds the size limit.');
      if (chunk.done) buffer += '\n\n';
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
        else if (!line && data) {
          const value = data;
          data = '';
          if (value === '[DONE]') return;
          yield object(JSON.parse(value));
        }
      }
      if (chunk.done) return;
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Runtime's per-turn, authenticated loopback adapter; no public listener or Google credential. */
export async function startAntigravityCopilotBridge(options: {
  model: string; effort?: string; baseUrl: string; key: string; fetch?: typeof globalThis.fetch;
}) {
  const apiKey = randomBytes(32).toString('hex');
  const secret = Buffer.from(apiKey);
  const controllers = new Set<AbortController>();
  let closing: Promise<void> | undefined;
  const request = options.fetch ?? globalThis.fetch;
  const server = createServer((req, res) => {
    void serve().catch(() => {
      if (!res.destroyed) {
        if (res.headersSent) res.destroy();
        else { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Copilot bridge request failed.' } })); }
      }
    });
    async function serve() {
      const supplied = Buffer.from(typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : '');
      if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
        res.writeHead(401); res.end(); return;
      }
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const match = /^\/v1beta\/models\/(.+):(streamGenerateContent|generateContent)$/.exec(pathname);
      if (req.method !== 'POST' || !match || decodeURIComponent(match[1]) !== options.model) {
        res.writeHead(404); res.end(); return;
      }
      const abort = new AbortController();
      controllers.add(abort);
      res.on('close', () => abort.abort());
      const deadline = setTimeout(() => abort.abort(), 5 * 60_000);
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const raw of req) {
          const chunk = Buffer.from(raw);
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { res.writeHead(413); res.end(); return; }
          chunks.push(chunk);
        }
        const payload = completionRequest(object(JSON.parse(Buffer.concat(chunks).toString('utf8'))), options.model, options.effort);
        const upstream = await request(`${options.baseUrl}/chat/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), redirect: 'error', signal: abort.signal,
        });
        if (!upstream.ok) {
          // Status is actionable; never forward arbitrary upstream text (which may echo keys/prompts).
          await upstream.body?.cancel();
          res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: upstream.status, message: `Copilot model API returned HTTP ${upstream.status}; check proxy model access.` } }));
          return;
        }
        if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
          await upstream.body?.cancel();
          throw new Error('Copilot did not return a streaming completion.');
        }
        await translate(upstream, res, match[2] === 'streamGenerateContent');
      } finally { clearTimeout(deadline); controllers.delete(abort); }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot start Copilot bridge.');
  return {
    credentials: { apiKey, baseUrl: `http://127.0.0.1:${address.port}`, vertex: false },
    close() {
      closing ??= (async () => {
        for (const controller of controllers) controller.abort();
        const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      })();
      return closing;
    },
  };
}

async function translate(upstream: Response, res: ServerResponse, streaming: boolean) {
  const calls = new Map<number, { id?: string; name: string; args: string }>();
  let completed = false, finishReason = 'STOP';
  let opaque = '';
  let usage: Json | undefined;
  const send = async (value: Json) => {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    if (!res.write(`data: ${JSON.stringify(value)}\n\n`)) await new Promise<void>((resolve, reject) => {
      const clean = () => { res.off('drain', drained); res.off('close', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error('SDK disconnected.')); };
      res.once('drain', drained);
      res.once('close', closed);
      if (res.destroyed) closed();
    });
  };
  const parts: Json[] = [];
  for await (const chunk of sse(upstream)) {
    if (chunk.error) throw new Error('Copilot reported a stream error.');
    if (chunk.usage) {
      const u = object(chunk.usage);
      usage = { promptTokenCount: u.prompt_tokens ?? 0, candidatesTokenCount: u.completion_tokens ?? 0,
        totalTokenCount: u.total_tokens ?? 0,
        cachedContentTokenCount: object(u.prompt_tokens_details).cached_tokens ?? 0,
        thoughtsTokenCount: object(u.completion_tokens_details).reasoning_tokens ?? 0 };
    }
    for (const raw of array(chunk.choices)) {
      const choice = object(raw), delta = object(choice.delta);
      if (typeof delta.reasoning_opaque === 'string') opaque += delta.reasoning_opaque;
      const emitted: Json[] = [];
      if (typeof delta.content === 'string' && delta.content) emitted.push({ text: delta.content });
      const thought = delta.reasoning_content ?? delta.reasoning_text;
      if (typeof thought === 'string' && thought) emitted.push({ text: thought, thought: true });
      if (emitted.length) {
        parts.push(...emitted);
        if (streaming) await send({ candidates: [{ content: { role: 'model', parts: emitted } }] });
      }
      for (const rawTool of array(delta.tool_calls)) {
        const tool = object(rawTool), fn = object(tool.function);
        if (!Number.isInteger(tool.index)) throw new Error('Invalid streamed tool index.');
        const index = Number(tool.index), call = calls.get(index) ?? { name: '', args: '' };
        if (typeof tool.id === 'string') call.id = tool.id;
        if (typeof fn.name === 'string') call.name += fn.name;
        if (typeof fn.arguments === 'string') call.args += fn.arguments;
        if (call.args.length > MAX_BYTES) throw new Error('Tool arguments exceed the size limit.');
        calls.set(index, call);
      }
      if (choice.finish_reason) {
        completed = true;
        finishReason = choice.finish_reason === 'length' ? 'MAX_TOKENS' : choice.finish_reason === 'content_filter' ? 'SAFETY' : 'STOP';
      }
    }
  }
  if (!completed) throw new Error('Copilot stream ended without a completion marker.');
  const toolParts = [...calls.values()].map(call => {
    if (!call.name) throw new Error('Incomplete tool call.');
    return { functionCall: { name: call.name, args: JSON.parse(call.args || '{}'), ...(call.id ? { id: call.id } : {}) } };
  });
  // Keep Copilot's opaque reasoning signature in the SDK's native history,
  // including when no visible thinking text was returned. It is not a Google key.
  const signature = opaque ? [{ thought: true, text: '', thoughtSignature: opaque }] : [];
  const final = { candidates: [{ content: { role: 'model', parts: [...(streaming ? [] : parts), ...signature, ...toolParts] }, finishReason }],
    ...(usage ? { usageMetadata: usage } : {}) };
  if (streaming) { await send(final); res.end(); }
  else { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(final)); }
}
