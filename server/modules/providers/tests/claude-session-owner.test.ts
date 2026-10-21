import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function turn(sessionId: string, prompt: string) {
  const sent: AnyRecord[] = [];
  const sessions = new ClaudeSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: (id) => (id ? providerIds.get(id) ?? null : null),
    resolveResumeModel: async (_id, requested) => requested ?? 'fake-model',
    getProviderModels: async () => ({ OPTIONS: [{ value: 'fake-model', label: 'Fake' }], DEFAULT: 'fake-model' }),
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
  };
  const writer = {
    userId: null,
    send: (message: unknown) => { sent.push(message as AnyRecord); },
    setSessionId: (id: string) => { providerIds.set(sessionId, id); },
  };
  await claudeRuntime.run(prompt, { sessionId, cwd: home, model: 'fake-model' }, writer, context);
  const texts = sent.filter((message) => message.kind === 'text').map((message) => String(message.content));
  return {
    sent,
    pid: Number(texts.map((text) => /pid: (\d+)/.exec(text)?.[1]).find(Boolean)),
    errors: sent.filter((message) => message.kind === 'error').map((message) => String(message.content)),
    exitCode: sent.find((message) => message.kind === 'complete')?.exitCode,
  };
}

async function register(pid: number, sessionId: string, fields: AnyRecord = {}) {
  const directory = path.join(home, '.claude', 'sessions');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${pid}.json`), JSON.stringify({
    pid, sessionId, kind: 'interactive', entrypoint: 'claude-desktop-3p', ...fields,
  }));
}

async function appendTranscriptTurn(sessionId: string, entrypoint: string) {
  const directory = path.join(home, '.claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(directory, { recursive: true });
  const rows = [
    { type: 'user', sessionId, entrypoint, message: { role: 'user', content: 'hi' } },
    { type: 'assistant', sessionId, entrypoint, message: { role: 'assistant', content: [] } },
    // Metadata rows that follow a turn carry no entrypoint.
    { type: 'last-prompt', sessionId },
  ];
  await writeFile(path.join(directory, `${sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { flag: 'a' });
}

// A live process that is not the test runner, standing in for Claude Desktop.
function startStandIn() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  return { pid: child.pid!, stop: () => child.kill() };
}

test('a session Claude Desktop has open is not continued, and nothing is started', { concurrency: false }, async () => {
  const first = await turn('owner-a', 'ECHO_PID');
  const desktop = startStandIn();
  try {
    await register(desktop.pid, providerIds.get('owner-a')!);
    const refused = await turn('owner-a', 'ECHO_PID');

    assert.ok(Number.isNaN(refused.pid), 'a process answered the refused turn');
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0], new RegExp(`open in Claude Desktop \\(process ${desktop.pid}\\)`));
    assert.match(refused.errors[0], /your message was not sent/);
    assert.equal(refused.exitCode, 1);
  } finally {
    desktop.stop();
  }

  // Once Desktop is gone the session continues, in a process that reloads it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const next = await turn('owner-a', 'ECHO_PID');
  assert.deepEqual(next.errors, []);
  assert.ok(next.pid > 0);
  assert.notEqual(next.pid, first.pid);
});

test('a terminal Claude Code process is named as such', { concurrency: false }, async () => {
  await turn('owner-b', 'ECHO_PID');
  const terminal = startStandIn();
  try {
    await register(terminal.pid, providerIds.get('owner-b')!, { entrypoint: 'cli' });
    const refused = await turn('owner-b', 'ECHO_PID');
    assert.match(refused.errors[0] ?? '', new RegExp(`another Claude Code process \\(cli, process ${terminal.pid}\\)`));
  } finally {
    terminal.stop();
  }
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
