import type { ChatMessage, VoiceRewriteMessage } from '@/shared/types';

// A conservative UTF-8 byte budget avoids adding a tokenizer to the browser.
const MAX_BYTES = 3000;
const MAX_MESSAGE_BYTES = 1000;

function boundedText(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let size = 0;
  let result = '';
  for (const character of text) {
    const bytes = encoder.encode(character).length;
    if (size + bytes > maxBytes) break;
    result += character;
    size += bytes;
  }
  return result.trim();
}

function referenceText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[credential omitted]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,})/gi, '[credential omitted]')
    .replace(/\b(?:api[_-]?key|password|token|secret)\s*[:=]\s*["']?[^\s"',;]+/gi, '[credential omitted]')
    .trim();
}

/** Used by the chat rewrite hook/tests: reference at most three user turns, never tool or reasoning payloads. */
export function selectVoiceRewriteHistory(messages: ChatMessage[]): VoiceRewriteMessage[] {
  const selected: VoiceRewriteMessage[] = [];
  let userTurns = 0;
  // Merge adjacent assistant prose before applying the six-message bound.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!['user', 'assistant'].includes(message.type) || message.isStreaming || message.isThinking ||
        message.isToolUse || message.isLocalCommand || message.isLocalCommandStdout ||
        message.isCompactSummary || message.isSubagentContainer || message.isTaskNotification ||
        typeof message.content !== 'string' || !message.content.trim()) continue;
    if (message.type === 'user' && ++userTurns > 3) break;
    const content = referenceText(message.content);
    if (!content) continue;
    const role = message.type as 'user' | 'assistant';
    const first = selected[0];
    if (role === 'assistant' && first?.role === role) first.content = `${content}\n${first.content}`;
    else selected.unshift({ role, content });
  }
  let remaining = MAX_BYTES;
  const result: VoiceRewriteMessage[] = [];
  for (const message of selected.slice(-6).reverse()) {
    const content = boundedText(message.content, Math.min(MAX_MESSAGE_BYTES, remaining));
    if (!content) break;
    remaining -= new TextEncoder().encode(content).length;
    result.unshift({ role: message.role, content });
  }
  return result;
}
