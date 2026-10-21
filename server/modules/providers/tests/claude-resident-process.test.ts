import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  claudeRuntime,
  retireIdleClaudeProcesses,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// The real Agent SDK drives a stand-in CLI (see fake-claude-cli.mjs) whose
// ECHO_PID answer tells a reused process from a new one.
const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude-cli.mjs');
const SETTINGS = ['HOME', 'CLAUDE_CLI_PATH', 'CODEY_MANAGED', 'CLAUDE_IDLE_PROCESS_TIMEOUT_MS', 'CLAUDE_MAX_IDLE_PROCESSES'];
const previous = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
let home = '';
// Native ids the runs report, which later turns resume, like the session row.
const providerIds = new Map<string, string>();

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-'));
  process.env.HOME = home;
  process.env.CLAUDE_CLI_PATH = FAKE_CLI;
  delete process.env.CODEY_MANAGED;
});

beforeEach(async () => {
  await retireIdleClaudeProcesses();
  delete process.env.CLAUDE_IDLE_PROCESS_TIMEOUT_MS;
  delete process.env.CLAUDE_MAX_IDLE_PROCESSES;
});

after(async () => {
  await retireIdleClaudeProcesses();
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

async function runTurn(sessionId: string, prompt: string, options: AnyRecord = {}) {
  const sent: AnyRecord[] = [];
  const sessions = new ClaudeSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: (id) => (id ? providerIds.get(id) ?? null : null),
    resolveResumeModel: async (_id, requested) => requested ?? 'fake-model',
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'fake-model', label: 'Fake' }, { value: 'other-model', label: 'Other' }],
      DEFAULT: 'fake-model',
    }),
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
  };
  const writer = {
    userId: null,
    send: (message: unknown) => { sent.push(message as AnyRecord); },
    setSessionId: (id: string) => { providerIds.set(sessionId, id); },
  };
  const done = claudeRuntime.run(prompt, { sessionId, cwd: home, model: 'fake-model', ...options }, writer, context);
  const texts = () => sent.filter((message) => message.kind === 'text').map((message) => `${message.role}:${message.content}`);
  const pid = () => Number(texts().map((text) => /pid: (\d+)/.exec(text)?.[1]).find(Boolean));
  return { sent, done, texts, pid };
}

async function turn(sessionId: string, prompt: string, options: AnyRecord = {}) {
  const run = await runTurn(sessionId, prompt, options);
  await run.done;
  return run;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const completes = (run: { sent: AnyRecord[] }) => run.sent.filter((message) => message.kind === 'complete');

test('the next turn of a session runs in the process that served the last one', { concurrency: false }, async () => {
  const first = await turn('resident-a', 'ECHO_PID first');
  const second = await turn('resident-a', 'ECHO_PID second');

  assert.ok(first.pid() > 0);
  assert.equal(second.pid(), first.pid());
  for (const run of [first, second]) {
    assert.equal(completes(run).length, 1);
    assert.equal(run.sent.at(-1)?.kind, 'complete');
  }
  // Between turns the session is idle: nothing to steer or stop.
  assert.equal(claudeRuntime.canSteer('resident-a'), false);
  assert.equal(await claudeRuntime.abort('resident-a'), false);
});

test('a turn launched differently, or an edit, gets a new process and the old one exits', { concurrency: false }, async () => {
  const first = await turn('resident-b', 'ECHO_PID first');
  const otherModel = await turn('resident-b', 'ECHO_PID other model', { model: 'other-model' });
  assert.notEqual(otherModel.pid(), first.pid());
  await until(() => !isRunning(first.pid()), 'the replaced process kept running');

  const edited = await turn('resident-b', 'ECHO_PID edited', { model: 'other-model', resumeAnchorId: 'assistant-row' });
  assert.notEqual(edited.pid(), otherModel.pid());
  await until(() => !isRunning(otherModel.pid()), 'the process before the edit kept running');
});

test('beyond the cap of idle processes, the least recently used exits', { concurrency: false }, async () => {
  process.env.CLAUDE_MAX_IDLE_PROCESSES = '1';
  const a = await turn('resident-c', 'ECHO_PID');
  const b = await turn('resident-d', 'ECHO_PID');
  await until(() => !isRunning(a.pid()), 'the older idle process outlived the cap');
  const c = await turn('resident-d', 'ECHO_PID');
  assert.equal(c.pid(), b.pid());
});

test('an idle process exits after the idle timeout', { concurrency: false }, async () => {
  // Set before the first turn: the environment is part of how a process is launched.
  process.env.CLAUDE_IDLE_PROCESS_TIMEOUT_MS = '300';
  const first = await turn('resident-j', 'ECHO_PID');
  const second = await turn('resident-j', 'ECHO_PID');
  assert.equal(second.pid(), first.pid());
  await until(() => !isRunning(second.pid()), 'the idle process outlived its timeout');
  const third = await turn('resident-j', 'ECHO_PID');
  assert.notEqual(third.pid(), second.pid());
});

test('no resident processes restores one process per turn', { concurrency: false }, async () => {
  process.env.CLAUDE_MAX_IDLE_PROCESSES = '0';
  const first = await turn('resident-e', 'ECHO_PID');
  await until(() => !isRunning(first.pid()), 'the process outlived its turn');
  const second = await turn('resident-e', 'ECHO_PID');
  assert.notEqual(second.pid(), first.pid());
});

test('callers without a session id never leave a process behind', { concurrency: false }, async () => {
  const run = await runTurn('', 'ECHO_PID one-off', { sessionId: undefined });
  await run.done;
  await until(() => !isRunning(run.pid()), 'a one-off process stayed resident');
});

test('background work reporting back between turns reaches the client and holds the process', { concurrency: false }, async () => {
  const started = await turn('resident-f', 'BG_TASK');
  // The follow-up turn arrives after the run completed, on its writer.
  await until(() => started.texts().includes('assistant:background report'), 'the background report never arrived');
  assert.equal(completes(started).length, 1);
  const next = await turn('resident-f', 'ECHO_PID');
  assert.ok(next.pid() > 0);
  assert.equal(next.texts().includes('assistant:background report'), false);
});

test('a turn sent while background work reports back is not ended by that report', { concurrency: false }, async () => {
  const started = await turn('resident-g', 'BG_TASK');
  // The report starts 150 ms after the result and answers 400 ms later.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const next = await turn('resident-g', 'ECHO_PID while busy');

  // The report the CLI was busy with reaches the new turn's client first and
  // does not complete it; the prompt's own answer does.
  assert.deepEqual(next.texts().map((text) => text.replace(/\d+/, 'N')), ['assistant:background report', 'assistant:pid: N']);
  assert.equal(completes(next).length, 1);
  assert.equal(next.sent.at(-1)?.kind, 'complete');
  assert.equal(completes(started).length, 1);
});

test('a turn sent as background work is about to report back waits for its own answer', { concurrency: false }, async () => {
  await turn('resident-k', 'BG_TASK_DUE');
  // The CLI is idle when the prompt arrives, but runs the report first.
  const next = await turn('resident-k', 'ECHO_PID');

  assert.deepEqual(next.texts().map((text) => text.replace(/\d+/, 'N')), ['assistant:background report', 'assistant:pid: N']);
  assert.equal(completes(next).length, 1);
  assert.equal(next.sent.at(-1)?.kind, 'complete');
});

test('Stop closes the process, and the next turn starts a new one', { concurrency: false }, async () => {
  const first = await turn('resident-h', 'ECHO_PID');
  const slow = await runTurn('resident-h', 'SLOW_TOOL');
  await until(() => slow.sent.some((message) => message.kind === 'tool_use'), 'the turn never reached its tool call');
  assert.equal(await claudeRuntime.abort('resident-h'), true);
  await slow.done;
  await until(() => !isRunning(first.pid()), 'the stopped process kept running');

  const next = await turn('resident-h', 'ECHO_PID');
  assert.notEqual(next.pid(), first.pid());
  assert.equal(completes(next).length, 1);
});

test('a resident process that dies between turns is replaced', { concurrency: false }, async () => {
  const first = await turn('resident-i', 'ECHO_PID');
  process.kill(first.pid(), 'SIGKILL');
  await until(() => !isRunning(first.pid()), 'the process survived SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const next = await turn('resident-i', 'ECHO_PID');
  assert.notEqual(next.pid(), first.pid());
  assert.equal(completes(next).length, 1);
  assert.equal(next.sent.some((message) => message.kind === 'error'), false);
});
