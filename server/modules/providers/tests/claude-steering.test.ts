import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// The real Agent SDK drives a stand-in CLI that queues mid-turn input the way
// the bundled Claude Code CLI does; see fake-claude-cli.mjs.
const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude-cli.mjs');

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startRun(prompt: string, sessionId: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-steering-'));
  const previous = { HOME: process.env.HOME, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH, CODEY_MANAGED: process.env.CODEY_MANAGED };
  process.env.HOME = home;
  process.env.CLAUDE_CLI_PATH = FAKE_CLI;
  delete process.env.CODEY_MANAGED;

  const sent: AnyRecord[] = [];
  const sessions = new ClaudeSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'fake-model',
    getProviderModels: async () => ({ OPTIONS: [{ value: 'fake-model', label: 'Fake' }], DEFAULT: 'fake-model' }),
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
  };
  const writer = { userId: null, send: (message: unknown) => { sent.push(message as AnyRecord); }, setSessionId: () => {} };
  const finished = claudeRuntime.run(prompt, { sessionId, cwd: home, model: 'fake-model' }, writer, context);
  const done = async () => {
    await finished;
    Object.assign(process.env, previous);
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name];
    await rm(home, { recursive: true, force: true });
  };
  return { sent, done, texts: () => sent.filter((message) => message.kind === 'text').map((message) => `${message.role}:${message.content}`) };
}

test('steering a running Claude turn folds the input in at its next tool boundary', { concurrency: false }, async () => {
  const run = await startRun('run TOOL', 'steer-tool');
  await until(() => run.sent.some((message) => message.kind === 'tool_use'), 'the turn never reached its tool call');

  assert.ok(run.sent.some((message) => message.kind === 'status' && message.canSteer === true),
    'the run advertises steering so the queued card can offer it');
  assert.equal(claudeRuntime.canSteer('steer-tool'), true);
  const receipt = await claudeRuntime.steer('steer-tool', 'also check X', {});
  assert.match(String(receipt?.clientMessageId), /^[0-9a-f-]{36}$/);
  await run.done();

  assert.deepEqual(run.texts(), ['assistant:done: run TOOL + also check X']);
  assert.equal(run.sent.filter((message) => message.kind === 'complete').length, 1);
  assert.equal(run.sent.at(-1)?.kind, 'complete');
  assert.equal(claudeRuntime.canSteer('steer-tool'), false);
  await assert.rejects(claudeRuntime.steer('steer-tool', 'too late', {}), { code: 'STEER_UNAVAILABLE' });
});

test('steering after the last tool boundary runs as a follow-up of the same turn', { concurrency: false }, async () => {
  const run = await startRun('WAIT_TEXT first', 'steer-follow-up');
  await until(() => run.texts().length > 0, 'the turn never answered');

  await claudeRuntime.steer('steer-follow-up', 'and the second', {});
  await run.done();

  // The client sees one turn: no completion between the answer and the
  // follow-up the steering started, and exactly one at the end.
  assert.deepEqual(run.texts(), ['assistant:answer: WAIT_TEXT first', 'assistant:answer: and the second']);
  assert.deepEqual(run.sent.filter((message) => message.kind === 'text' || message.kind === 'complete')
    .map((message) => message.kind), ['text', 'text', 'complete']);
});

test('stopping a steered turn drops the steering instead of running it afterwards', { concurrency: false }, async () => {
  const run = await startRun('SLOW_TOOL', 'steer-stop');
  await until(() => run.sent.some((message) => message.kind === 'tool_use'), 'the turn never reached its tool call');

  await claudeRuntime.steer('steer-stop', 'never run this', {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await claudeRuntime.abort('steer-stop'), true);
  await run.done();

  assert.equal(run.texts().some((text) => text.includes('never run this')), false);
  assert.equal(claudeRuntime.canSteer('steer-stop'), false);
});
