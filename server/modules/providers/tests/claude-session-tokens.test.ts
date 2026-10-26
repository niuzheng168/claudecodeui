import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK, retireIdleClaudeProcesses } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { readClaudeSessionTokens } from '@/modules/providers/services/provider-token-usage.service.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The composer shows the session's token total beside its context. A resumed
 * run starts from what the transcript already holds and adds each request it
 * makes, once per request: the SDK repeats a request's usage on every content
 * block, and the transcript catches up with requests the run already counted.
 */

const usage = (input: number, output: number) => ({ input_tokens: 2, cache_read_input_tokens: input - 2, output_tokens: output });

const transcriptRow = (id: string, input: number, output: number) => `${JSON.stringify({
  type: 'assistant', uuid: `row-${id}`, sessionId: 'native-total', message: { id, usage: usage(input, output) },
})}\n`;

const assistant = (id: string, input: number, output: number, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  session_id: 'native-total',
  parent_tool_use_id: null,
  message: { id, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: usage(input, output) },
  ...extra,
});

test('a resumed run reports the transcript\'s total plus each request it makes, once', async () => {
  // The managed gateway would only accept its own catalog's models.
  const previousCodeyManaged = process.env.CODEY_MANAGED;
  delete process.env.CODEY_MANAGED;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-session-tokens-'));
  const transcriptPath = path.join(tempDirectory, 'native-total.jsonl');
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await writeFile(transcriptPath, transcriptRow('msg_a', 10_000, 300) + transcriptRow('msg_b', 12_000, 500));
    sessionsDb.createSession('native-total', 'claude', tempDirectory, 'Totals', undefined, undefined, transcriptPath);
    const before = 10_300 + 12_500;

    const stream = async function* () {
      // The CLI takes a moment to start; the run counts the transcript meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield { type: 'system', subtype: 'init', session_id: 'native-total' };
      yield assistant('msg_c', 14_000, 100);
      // A second content block of the same request.
      yield assistant('msg_c', 14_000, 100);
      // A subagent's request never enters this session.
      yield assistant('msg_sub', 3_000, 50, { parent_tool_use_id: 'toolu_1' });
      // The CLI writes the request to the transcript and the history is reread.
      await appendFile(transcriptPath, transcriptRow('msg_c', 14_000, 100));
      await readClaudeSessionTokens(transcriptPath);
      yield assistant('msg_d', 15_000, 200);
      yield { type: 'result', subtype: 'success', session_id: 'native-total', result: 'ok', duration_ms: 1, num_turns: 1 };
    };

    const sent: NormalizedMessage[] = [];
    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => 'native-total',
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
      normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
      createQuery: ({ prompt }) => {
        void (async () => { for await (const _message of prompt) { /* read */ } })();
        return Object.assign(stream(), { interrupt: async () => {} }) as never;
      },
    };
    const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
    await queryClaudeSDK('hello', { sessionId: 'native-total', cwd: tempDirectory }, writer as never, context);

    const totals = sent
      .filter((message) => message.kind === 'status' && message.text === 'token_budget')
      .map((message) => (message.tokenBudget as { sessionTokens?: number }).sessionTokens);
    assert.deepEqual(totals, [before + 14_100, before + 14_100, before + 14_100 + 15_200]);
  } finally {
    await retireIdleClaudeProcesses();
    closeConnection();
    for (const [name, value] of Object.entries({ DATABASE_PATH: previousDatabasePath, CODEY_MANAGED: previousCodeyManaged })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
