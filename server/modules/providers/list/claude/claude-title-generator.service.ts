import { codeyClaudeGateway } from '@/modules/providers/services/codey-claude-gateway.service.js';
import {
  SESSION_TITLE_INSTRUCTIONS, SESSION_TITLE_SCHEMA, parseSessionTitle, readBoundedJsonResponse,
} from '@/shared/index.js';
import type { AnyRecord } from '@/shared/index.js';

const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type TitleInput = {
  message: string;
  model: string;
  signal: AbortSignal;
};

function messageTitle(response: AnyRecord | null): string | null {
  // A truncated, refused or tool-using reply is a miss, not a partial title.
  if (response?.type !== 'message' || response.role !== 'assistant'
    || response.stop_reason !== 'end_turn' || !Array.isArray(response.content)) return null;
  const texts: string[] = [];
  for (const block of response.content) {
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') continue;
    if (block?.type !== 'text' || typeof block.text !== 'string') return null;
    texts.push(block.text);
  }
  return parseSessionTitle(texts.join(''));
}

/**
 * Used by Claude's background naming service and its offline HTTP tests.
 * One bounded, tool-free Messages request goes to the managed Codey gateway
 * with its validated key. It is not a Claude Code turn and never touches the
 * session's transcript. Unmanaged nodes and invalid output are a best-effort
 * miss; nothing falls back to a personal Claude login or another endpoint.
 */
export async function generateClaudeSessionTitle(
  input: TitleInput,
  dependencies: {
    fetch?: typeof fetch;
    gateway?: Pick<typeof codeyClaudeGateway, 'messagesRequest'>;
  } = {},
): Promise<string | null> {
  if (!input.model.trim() || !input.message.trim()) return null;
  const request = (dependencies.gateway ?? codeyClaudeGateway).messagesRequest();
  if (!request) return null;
  input.signal.throwIfAborted();
  const response = await (dependencies.fetch ?? fetch)(request.url, {
    method: 'POST', redirect: 'error', signal: input.signal,
    headers: { ...request.headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: input.model,
      system: SESSION_TITLE_INSTRUCTIONS,
      messages: [{ role: 'user', content: input.message.trim().slice(0, MAX_MESSAGE_CHARACTERS) }],
      max_tokens: 512, stream: false,
      // Current Claude models think adaptively and the gateway rejects
      // disabling it; low effort keeps a title to a short direct answer.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SESSION_TITLE_SCHEMA } },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const result = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
  input.signal.throwIfAborted();
  return messageTitle(result);
}
