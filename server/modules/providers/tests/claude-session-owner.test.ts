import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  claudeRuntime,
  retireClaudeProcessesOpenedElsewhere,
  retireIdleClaudeProcesses,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { readForeignRegistrationSessionId } from '@/modules/providers/list/claude/claude-session-owner.service.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// The real Agent SDK drives a stand-in CLI (see fake-claude-cli.mjs) whose
// ECHO_PID answer tells a reused process from a new one. Other Claude Code
// processes are played by session registrations and transcript rows written
// the way Claude Code writes them.
const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude-cli.mjs');
const SETTINGS = ['HOME', 'CLAUDE_CLI_PATH', 'CODEY_MANAGED', 'CLAUDE_CODE_ENTRYPOINT'];
const previous = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
let home = '';
const providerIds = new Map<string, string>();

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'claude-owner-'));
  process.env.HOME = home;
  process.env.CLAUDE_CLI_PATH = FAKE_CLI;
  delete process.env.CODEY_MANAGED;
});

beforeEach(async () => {
  await retireIdleClaudeProcesses();
  await rm(path.join(home, '.claude'), { recursive: true, force: true });
});

after(async () => {
  await retireIdleClaudeProcesses();
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

function runtimeContext(): ProviderRuntimeContext {
  const sessions = new ClaudeSessionsProvider();
  return {
    resolveProviderSessionId: (id) => (id ? providerIds.get(id) ?? null : null),
    resolveResumeModel: async (_id, requested) => requested ?? 'fake-model',
    getProviderModels: async () => ({ OPTIONS: [{ value: 'fake-model', label: 'Fake' }], DEFAULT: 'fake-model' }),
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
  };
}

function collector(sessionId: string) {
  const sent: AnyRecord[] = [];
  const writer = {
    userId: null,
    send: (message: unknown) => { sent.push(message as AnyRecord); },
    setSessionId: (id: string) => { providerIds.set(sessionId, id); },
  };
  return { sent, writer };
}

function summarize(sent: AnyRecord[]) {
  const texts = sent.filter((message) => message.kind === 'text').map((message) => String(message.content));
  return {
    sent,
    texts,
    pid: Number(texts.map((text) => /pid: (\d+)/.exec(text)?.[1]).find(Boolean)),
    errors: sent.filter((message) => message.kind === 'error'),
    statuses: sent.filter((message) => message.kind === 'status' && message.text).map((message) => String(message.text)),
    exitCode: sent.find((message) => message.kind === 'complete')?.exitCode,
  };
}

// Starts a turn without waiting for it, for tests that act while it runs.
function startTurn(sessionId: string, prompt: string, options: AnyRecord = {}) {
  const { sent, writer } = collector(sessionId);
  const done = claudeRuntime.run(prompt, { sessionId, cwd: home, model: 'fake-model', ...options }, writer, runtimeContext())
    .then(() => summarize(sent));
  return { sent, done };
}

async function turn(sessionId: string, prompt: string, options: AnyRecord = {}) {
  return startTurn(sessionId, prompt, options).done;
}

async function register(pid: number, sessionId: string, fields: AnyRecord = {}) {
  const directory = path.join(home, '.claude', 'sessions');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${pid}.json`), JSON.stringify({
    pid, sessionId, kind: 'interactive', entrypoint: 'claude-desktop-3p', status: 'idle', ...fields,
  }));
}

async function appendRows(sessionId: string, rows: AnyRecord[]) {
  const directory = path.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { flag: 'a' });
}

async function appendTranscriptTurn(sessionId: string, entrypoint: string) {
  await appendRows(sessionId, [
    { type: 'user', sessionId, entrypoint, message: { role: 'user', content: 'hi' } },
    { type: 'assistant', sessionId, entrypoint, message: { role: 'assistant', content: [] } },
    // Metadata rows that follow a turn carry no entrypoint.
    { type: 'last-prompt', sessionId },
  ]);
}

// What Claude Desktop writes while it runs a turn.
function desktopTurnRows(sessionId: string, prompt: string, reply: string) {
  return [
    { type: 'user', uuid: randomUUID(), sessionId, entrypoint: 'claude-desktop-3p', message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: randomUUID(), sessionId, entrypoint: 'claude-desktop-3p', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
  ];
}

// A live process that is not the test runner, standing in for Claude Desktop
// or a terminal. `ended` names the signal that ended it.
function startStandIn(script = 'setTimeout(() => {}, 60_000)') {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const ended = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
  return { pid: child.pid!, ended, stop: () => child.kill() };
}

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('an idle Claude Desktop process is ended and the session continues here', { concurrency: false }, async () => {
  const first = await turn('owner-a', 'ECHO_PID');
  const desktop = startStandIn();
  await register(desktop.pid, providerIds.get('owner-a')!);

  const next = await turn('owner-a', 'ECHO_PID');

  assert.equal(await desktop.ended, 'SIGTERM');
  assert.deepEqual(next.errors, []);
  assert.ok(next.statuses.includes('Taking this session over from Claude Desktop'));
  // The idle process Codey kept held the conversation as it was before Desktop.
  assert.ok(next.pid > 0);
  assert.notEqual(next.pid, first.pid);
});

test('a terminal\'s process is ended only once the user confirms', { concurrency: false }, async () => {
  await turn('owner-b', 'ECHO_PID');
  const terminal = startStandIn();
  try {
    await register(terminal.pid, providerIds.get('owner-b')!, { entrypoint: 'cli' });
    const refused = await turn('owner-b', 'ECHO_PID');

    assert.ok(Number.isNaN(refused.pid), 'a process answered the refused turn');
    assert.equal(refused.errors.length, 1);
    assert.match(String(refused.errors[0].content), new RegExp(`another Claude Code process \\(cli, process ${terminal.pid}\\)`));
    assert.match(String(refused.errors[0].content), /Your message was not sent/);
    assert.equal(refused.errors[0].code, 'CLAUDE_SESSION_OPEN_ELSEWHERE');
    assert.deepEqual(refused.errors[0].takeOver, { pid: terminal.pid, entrypoint: 'cli', canTakeOver: true, messageId: null });
    assert.equal(refused.exitCode, 1);

    const confirmed = await turn('owner-b', 'ECHO_PID', { takeOver: true });
    assert.equal(await terminal.ended, 'SIGTERM');
    assert.deepEqual(confirmed.errors, []);
    assert.ok(confirmed.pid > 0);
  } finally {
    terminal.stop();
  }
});

test('a background session is never ended', { concurrency: false }, async () => {
  await turn('owner-f', 'ECHO_PID');
  const background = startStandIn();
  try {
    await register(background.pid, providerIds.get('owner-f')!, { entrypoint: 'cli', kind: 'bg' });
    const refused = await turn('owner-f', 'ECHO_PID', { takeOver: true });
    assert.equal(refused.errors[0]?.takeOver?.canTakeOver, false);
    assert.match(String(refused.errors[0]?.content), /background session/);
    const stillRunning = await Promise.race([background.ended.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 200))]);
    assert.equal(stillRunning, true);
  } finally {
    background.stop();
  }
});

test('a turn Claude Desktop is running is shown and finished before the session is taken over', { concurrency: false }, async () => {
  await turn('owner-g', 'ECHO_PID');
  const providerId = providerIds.get('owner-g')!;
  const desktop = startStandIn();
  await register(desktop.pid, providerId, { status: 'busy' });

  const pending = startTurn('owner-g', 'ECHO_PID');
  await appendRows(providerId, desktopTurnRows(providerId, 'desktop prompt', 'desktop reply'));
  await until(() => pending.sent.some((message) => message.content === 'desktop reply'), 'the Desktop reply to be forwarded');
  assert.ok(pending.sent.some((message) => message.kind === 'status' && message.text === 'Waiting for Claude Desktop to finish its turn'));
  assert.ok(pending.sent.some((message) => message.role === 'user' && message.content === 'desktop prompt'));
  assert.ok(!pending.sent.some((message) => /pid: \d+/.test(String(message.content))), 'the turn ran before Desktop finished');

  await register(desktop.pid, providerId, { status: 'idle' });
  const next = await pending.done;
  assert.equal(await desktop.ended, 'SIGTERM');
  assert.deepEqual(next.errors, []);
  assert.ok(next.pid > 0);
});

test('stopping a turn that waits for Claude Desktop leaves Desktop running', { concurrency: false }, async () => {
  await turn('owner-h', 'ECHO_PID');
  const providerId = providerIds.get('owner-h')!;
  const desktop = startStandIn();
  try {
    await register(desktop.pid, providerId, { status: 'busy' });
    const pending = startTurn('owner-h', 'ECHO_PID');
    await until(() => pending.sent.some((message) => message.kind === 'status' && message.text), 'the turn to wait');

    assert.equal(await claudeRuntime.abort('owner-h'), true);
    const stopped = await pending.done;
    assert.deepEqual(stopped.errors, []);
    assert.ok(Number.isNaN(stopped.pid));
    const stillRunning = await Promise.race([desktop.ended.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 200))]);
    assert.equal(stillRunning, true);
  } finally {
    desktop.stop();
  }
});

test('an open tab follows a turn Claude Desktop runs, and Stop interrupts it', { concurrency: false }, async () => {
  await turn('owner-i', 'ECHO_PID');
  const providerId = providerIds.get('owner-i')!;
  const context = runtimeContext();
  assert.equal(await claudeRuntime.prepareObservation!('owner-i', context), null, 'nothing to follow');

  const desktop = startStandIn();
  try {
    await register(desktop.pid, providerId, { status: 'busy' });
    await appendRows(providerId, desktopTurnRows(providerId, 'first prompt', 'first reply'));
    const observation = await claudeRuntime.prepareObservation!('owner-i', context);
    assert.ok(observation);
    const { sent, writer } = collector('owner-i');
    const following = observation.start(writer);
    await until(() => sent.some((message) => message.content === 'first reply'), 'the reply so far');
    assert.ok(sent.some((message) => message.kind === 'status' && message.text === 'Claude Desktop is running this turn'));

    await appendRows(providerId, [desktopTurnRows(providerId, '', 'second reply')[1]]);
    await until(() => sent.some((message) => message.content === 'second reply'), 'a row written later');
    await register(desktop.pid, providerId, { status: 'idle' });
    await following;
    assert.equal(sent.at(-1)?.kind, 'complete');
    assert.equal(sent.at(-1)?.exitCode, 0);

    // A later turn: an automatic stop is refused, the user's Stop interrupts it.
    await register(desktop.pid, providerId, { status: 'busy' });
    const second = await claudeRuntime.prepareObservation!('owner-i', context);
    const secondTab = collector('owner-i');
    const followingSecond = second!.start(secondTab.writer);
    await until(() => secondTab.sent.some((message) => message.kind === 'status'), 'the observation to start');
    assert.equal(await claudeRuntime.abort('owner-i'), false);
    assert.equal(await claudeRuntime.abort('owner-i', { allowExternalTurn: true }), true);
    assert.equal(await desktop.ended, 'SIGINT');
    await followingSecond;
  } finally {
    desktop.stop();
  }
});

test('an idle process Codey kept is retired once another process opens its session', { concurrency: false }, async () => {
  const first = await turn('owner-j', 'ECHO_PID');
  retireClaudeProcessesOpenedElsewhere(providerIds.get('owner-j')!);
  const next = await turn('owner-j', 'ECHO_PID');
  assert.notEqual(next.pid, first.pid);
});

test('only registrations of processes outside Codey name a session to refresh', { concurrency: false }, async () => {
  await register(101, 'desktop-session');
  await register(102, 'codey-session', { entrypoint: 'sdk-ts' });
  const directory = path.join(home, '.claude', 'sessions');
  assert.equal(await readForeignRegistrationSessionId(path.join(directory, '101.json')), 'desktop-session');
  assert.equal(await readForeignRegistrationSessionId(path.join(directory, '102.json')), null);
  assert.equal(await readForeignRegistrationSessionId(path.join(directory, '103.json')), null);
});

test('Codey\'s own, exited, reused-pid and other sessions\' registrations do not block', { concurrency: false }, async () => {
  const first = await turn('owner-c', 'ECHO_PID');
  const providerId = providerIds.get('owner-c')!;
  const exited = startStandIn();
  exited.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const other = startStandIn();
  try {
    await register(process.pid, providerId, { entrypoint: 'sdk-ts' });
    await register(exited.pid, providerId);
    await register(other.pid, 'another-session');
    if (process.platform === 'linux') {
      await register(process.ppid, providerId, { procStart: '1' });
    }
    const next = await turn('owner-c', 'ECHO_PID');
    assert.deepEqual(next.errors, []);
    assert.equal(next.pid, first.pid);
  } finally {
    other.stop();
  }
});

test('the session\'s processes register as Codey\'s even when the node inherited another entrypoint', { concurrency: false }, async () => {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop-3p';
  try {
    const first = await turn('owner-d', 'ECHO_ENTRYPOINT');
    assert.equal(first.errors.length, 0);
    assert.ok(first.sent.some((message) => message.kind === 'text' && message.content === 'entrypoint: sdk-ts'));
  } finally {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
  }
});

test('a resident process is not reused after another process continued the session', { concurrency: false }, async () => {
  const first = await turn('owner-e', 'ECHO_PID');
  const providerId = providerIds.get('owner-e')!;
  await appendTranscriptTurn(providerId, 'sdk-ts');
  const second = await turn('owner-e', 'ECHO_PID');
  assert.equal(second.pid, first.pid);

  await appendTranscriptTurn(providerId, 'claude-desktop-3p');
  const third = await turn('owner-e', 'ECHO_PID');
  assert.deepEqual(third.errors, []);
  assert.notEqual(third.pid, first.pid);
});
