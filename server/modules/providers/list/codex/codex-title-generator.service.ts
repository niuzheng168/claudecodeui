import {
  SESSION_TITLE_INSTRUCTIONS, SESSION_TITLE_SCHEMA, parseSessionTitle, readBoundedJsonResponse, readObjectRecord,
} from '@/shared/index.js';
import type { AnyRecord } from '@/shared/index.js';

const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type TitleInput = {
  message: string;
  model: string;
  modelProvider: string;
  config: AnyRecord;
  signal: AbortSignal;
};

function providerRequest(input: TitleInput, environment: NodeJS.ProcessEnv): {
  url: URL;
  headers: Headers;
} | null {
  // Use the native thread's actual provider, not an unrelated default, OAuth
  // token, hard-coded endpoint or another account when config has changed.
  if (input.config.model_provider !== input.modelProvider) return null;
  const provider = readObjectRecord(input.config.model_providers?.[input.modelProvider]);
  if (!provider || provider.requires_openai_auth !== false || provider.wire_api !== 'responses'
    || typeof provider.base_url !== 'string') return null;
  let url: URL;
  try { url = new URL(provider.base_url); } catch { return null; }
  if (url.username || url.password || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`;
  const query = readObjectRecord(provider.query_params);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string') return null;
      url.searchParams.set(key, value);
    }
  }

  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  for (const [values, fromEnvironment] of [
    [readObjectRecord(provider.http_headers), false],
    [readObjectRecord(provider.env_http_headers), true],
  ] as const) {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (typeof value !== 'string' || /^(host|content-length|connection|transfer-encoding)$/i.test(key)) return null;
      const resolved = fromEnvironment ? environment[value] : value;
      if (!resolved?.trim()) return null;
      headers.set(key, resolved);
    }
  }
  if (provider.env_key != null) {
    if (typeof provider.env_key !== 'string') return null;
    const token = environment[provider.env_key];
    if (!token?.trim()) return null;
    headers.set('authorization', `Bearer ${token}`);
  } else if (provider.experimental_bearer_token || provider.auth) {
    // These require Codex-owned credential resolution. Never extract its
    // ChatGPT login or silently switch to a different authentication source.
    return null;
  }
  return { url, headers };
}

function responseTitle(response: AnyRecord | null): string | null {
  if (response?.status !== 'completed' || response.error || !Array.isArray(response.output)) return null;
  const texts: string[] = [];
  for (const item of response.output) {
    if (item?.type === 'reasoning') continue;
    if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) return null;
    for (const content of item.content) {
      if (content?.type !== 'output_text' || typeof content.text !== 'string') return null;
      texts.push(content.text);
    }
  }
  return parseSessionTitle(texts.join(''));
}

/**
 * Used by Codex's background naming service and its offline HTTP tests.
 * One bounded, tool-free Responses request uses the configured custom provider
 * and existing credentials. It neither creates a Codex thread nor adds a turn
 * to the user's history. Unsupported authentication or invalid output is a
 * best-effort miss, not permission to try another endpoint/account.
 */
export async function generateCodexSessionTitle(
  input: TitleInput,
  dependencies: { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const request = providerRequest(input, dependencies.environment ?? process.env);
  if (!request || !input.model.trim() || !input.message.trim()) return null;
  input.signal.throwIfAborted();
  const response = await (dependencies.fetch ?? fetch)(request.url, {
    method: 'POST', headers: request.headers, redirect: 'error', signal: input.signal,
    body: JSON.stringify({
      model: input.model,
      instructions: SESSION_TITLE_INSTRUCTIONS,
      input: [{ role: 'user', content: [{
        type: 'input_text', text: input.message.trim().slice(0, MAX_MESSAGE_CHARACTERS),
      }] }],
      tools: [], tool_choice: 'none', store: false, stream: false, max_output_tokens: 512,
      ...(/^(?:gpt-[5-9](?:[.-]|$)|o[1-9])/i.test(input.model) ? { reasoning: { effort: 'low' } } : {}),
      text: { format: {
        type: 'json_schema', name: 'conversation_title', strict: true, schema: SESSION_TITLE_SCHEMA,
      } },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const result = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
  input.signal.throwIfAborted();
  return responseTitle(result);
}
