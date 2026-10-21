import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createClaudeNativeCommandsService,
  discoverClaudeSlashCommands,
} from '@/modules/providers/list/claude/claude-commands.provider.js';
import { claudeRuntime, retireIdleClaudeProcesses } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// Sessions keep their Claude Code process between turns; end them with the file.
after(() => retireIdleClaudeProcesses());

// The real Agent SDK drives a stand-in CLI that streams local commands the way
// the bundled Claude Code CLI does; see fake-claude-cli.mjs.
const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude-cli.mjs');

const SUPPORTED = [
  { name: 'compact', description: 'Free up context', argumentHint: '' },
  { name: 'usage', description: 'Show the total cost', argumentHint: '', aliases: ['cost'] },
  { name: 'context', description: 'Show current context usage', argumentHint: '' },
];

async function withFakeCli<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-native-commands-'));
  const previous = { HOME: process.env.HOME, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH, CODEY_MANAGED: process.env.CODEY_MANAGED };
  process.env.HOME = home;
  process.env.CLAUDE_CLI_PATH = FAKE_CLI;
  delete process.env.CODEY_MANAGED;
  try {
    return await run(home);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function runTurn(prompt: string, sessionId: string, during?: () => Promise<void>) {
  return withFakeCli(async (home) => {
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
    await during?.();
    await finished;
    return sent;
  });
}

const textsOf = (sent: AnyRecord[]) => sent
  .filter((message) => message.kind === 'text')
  .map((message) => `${message.role}:${message.content}`);

test('discovery asks the CLI and keeps only the commands that work through Codey', { concurrency: false }, async () => {
  await withFakeCli(async () => {
    const supported = await discoverClaudeSlashCommands();
    assert.ok(supported.some((command) => command.name === 'clear'), 'the CLI reports everything it supports');

    const commands = await createClaudeNativeCommandsService().list();
    // `clear` and `usage` misbehave in per-turn processes, `goal` is Codex's,
    // and the user's own skills come from Codey's skill listing.
    assert.deepEqual(commands, [
      { name: '/compact', description: 'Free up context by summarizing the conversation so far' },
      { name: '/context', description: 'Show current context usage' },
      { name: '/simplify', description: 'Review the changed code for cleanups' },
    ]);
  });
});

test('discovery runs once per process and is shared by concurrent menus', async () => {
  let calls = 0;
  const service = createClaudeNativeCommandsService({ discover: async () => { calls += 1; return SUPPORTED; } });

  const [first, second] = await Promise.all([service.list(), service.list()]);
  const third = await service.list();

  assert.equal(calls, 1);
  assert.deepEqual(first.map((command) => command.name), ['/compact', '/context']);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test('a slow discovery does not hold the menu, and fills the cache for the next one', async () => {
  let finish!: (commands: typeof SUPPORTED) => void;
  let calls = 0;
  const service = createClaudeNativeCommandsService({
    discover: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); },
  });

  assert.deepEqual(await service.list(10), []);
  finish(SUPPORTED);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual((await service.list(10)).map((command) => command.name), ['/compact', '/context']);
  assert.equal(calls, 1);
});

test('a failed discovery lists nothing and is retried after a pause, not on every menu', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let clock = 0;
  let calls = 0;
  const service = createClaudeNativeCommandsService({
    now: () => clock,
    discover: async () => {
      calls += 1;
      if (calls === 1) throw new Error('claude not installed');
      return SUPPORTED;
    },
  });

  assert.deepEqual(await service.list(), []);
  assert.deepEqual(await service.list(), []);
  assert.equal(calls, 1);

  clock += 61_000;
  assert.deepEqual((await service.list()).map((command) => command.name), ['/compact', '/context']);
  assert.equal(calls, 2);
});

test('a stale list is served at once while it refreshes in the background', async () => {
  let clock = 0;
  let calls = 0;
  const service = createClaudeNativeCommandsService({
    now: () => clock,
    discover: async () => {
      calls += 1;
      return calls === 1 ? SUPPORTED : [...SUPPORTED, { name: 'simplify', description: 'Clean up', argumentHint: '' }];
    },
  });
  await service.list();

  clock += 7 * 60 * 60 * 1000;
  assert.deepEqual((await service.list()).map((command) => command.name), ['/compact', '/context']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual((await service.list()).map((command) => command.name), ['/compact', '/context', '/simplify']);
});

test('a local command\'s output streams as text without zeroing the context counter', { concurrency: false }, async () => {
  const sent = await runTurn('/context', 'native-context');

  assert.deepEqual(textsOf(sent), ['assistant:## Context Usage\n\n**Tokens:** 30.4k / 633k (5%)']);
  // The output and the turn's result report all-zero usage; neither is the
  // session's context.
  assert.equal(sent.some((message) => message.text === 'token_budget'), false);
  assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
});

test('/compact streams like history shows it: status, folded summary, and its output once', { concurrency: false }, async () => {
  const sent = await runTurn('/compact', 'native-compact');

  assert.deepEqual(
    sent.filter((message) => message.kind === 'status' && typeof message.text === 'string' && message.text !== 'token_budget')
      .map((message) => message.text),
    ['Compacting conversation', ''],
  );
  const texts = sent.filter((message) => message.kind === 'text');
  assert.deepEqual(texts.map((message) => [message.role, message.isCompactSummary === true]), [
    ['assistant', true],
    ['assistant', false],
  ]);
  assert.match(String(texts[0].content), /^This session is being continued/);
  // The kept tail the CLI streams again is already on screen.
  assert.equal(texts[1].content, 'Compacted');
  assert.equal(sent.some((message) => message.text === 'token_budget'), false);
});

test('a slash command is not steered into a running turn; it stays queued for its own', { concurrency: false }, async () => {
  const sent = await runTurn('run TOOL', 'native-steer', async () => {
    const deadline = Date.now() + 10_000;
    while (!claudeRuntime.canSteer('native-steer')) {
      if (Date.now() > deadline) assert.fail('the turn never became steerable');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await assert.rejects(claudeRuntime.steer('native-steer', '/compact keep the API notes', {}), { code: 'STEER_UNAVAILABLE' });
    // A path is not a command, and ordinary steering is unaffected.
    await claudeRuntime.steer('native-steer', '/etc/hosts looks wrong', {});
  });

  assert.deepEqual(textsOf(sent), ['assistant:done: run TOOL + /etc/hosts looks wrong']);
});
