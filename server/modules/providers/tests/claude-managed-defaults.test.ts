import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { claudeRuntime, retireIdleClaudeProcesses } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { claudeCodeRefusesBypassPermissions } from '@/modules/providers/services/codey-claude-gateway.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { AnyRecord, ProviderModelsDefinition, ProviderRuntimeContext } from '@/shared/types.js';

// The real Agent SDK drives a stand-in CLI that reports the flags it was
// launched with (ECHO_FLAGS) or asks about an AskUserQuestion call (ASK_USER).
const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude-cli.mjs');
const ENV_NAMES = ['HOME', 'CLAUDE_CLI_PATH', 'CODEY_MANAGED', 'CODEY_MODEL_API_KEY', 'IS_SANDBOX', 'CLAUDE_CODE_BUBBLEWRAP'];

const CATALOG: ProviderModelsDefinition = {
  DEFAULT: 'fake-model',
  OPTIONS: [{
    value: 'fake-model',
    label: 'Fake',
    effort: { default: 'max', values: ['low', 'high', 'max'].map((value) => ({ value })) },
  }],
};

/** Runs `fn` with the given environment and uid, restoring both afterwards. */
async function withProcess<T>(env: Record<string, string>, uid: number | null, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const getuid = process.getuid;
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, env);
  if (uid !== null) process.getuid = () => uid;
  try {
    return await fn();
  } finally {
    process.getuid = getuid;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// Sessions keep their Claude Code process between turns; end them with the file.
after(() => retireIdleClaudeProcesses());

const MANAGED = { CODEY_MANAGED: 'true', CODEY_MODEL_API_KEY: 'private-test-key' };

async function run(prompt: string, sessionId: string, options: AnyRecord, {
  env = {}, uid = null, onSend,
}: { env?: Record<string, string>; uid?: number | null; onSend?: (message: AnyRecord) => void } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-defaults-'));
  const sent: AnyRecord[] = [];
  try {
    await withProcess({ ...env, HOME: home, CLAUDE_CLI_PATH: FAKE_CLI }, uid, async () => {
      const sessions = new ClaudeSessionsProvider();
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => 'fake-model',
        getProviderModels: async () => CATALOG,
        normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
        isProviderInstalled: async () => true,
      };
      const writer = {
        userId: null,
        send: (message: unknown) => { sent.push(message as AnyRecord); onSend?.(message as AnyRecord); },
        setSessionId: () => {},
      };
      await claudeRuntime.run(prompt, { sessionId, cwd: home, model: 'fake-model', ...options }, writer, context);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  return {
    sent,
    texts: sent.filter((message) => message.kind === 'text').map((message) => String(message.content)),
    errors: sent.filter((message) => message.kind === 'error').map((message) => String(message.content)),
  };
}

test('managed Claude chats default to full access, like managed Codex', async () => {
  await withProcess({}, 1000, async () => {
    assert.equal(providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode, 'default');
  });
  await withProcess(MANAGED, 1000, async () => {
    const all = providerCapabilitiesService.listAllProviderCapabilities();
    assert.equal(all.find(({ provider }) => provider === 'claude')?.defaultPermissionMode, 'bypassPermissions');
    // Codex keeps its own capability default; its runtime config owns full access.
    assert.equal(all.find(({ provider }) => provider === 'codex')?.defaultPermissionMode, 'default');
  });
  // Claude Code refuses full access to root outside a sandbox, so it is not offered as the default.
  await withProcess(MANAGED, 0, async () => {
    assert.equal(providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode, 'default');
  });
  await withProcess({ ...MANAGED, IS_SANDBOX: '1' }, 0, async () => {
    assert.equal(providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode, 'bypassPermissions');
  });
});

test('the root refusal mirrors Claude Code\'s own check', () => {
  assert.equal(claudeCodeRefusesBypassPermissions({}, 0), true);
  assert.equal(claudeCodeRefusesBypassPermissions({}, 1000), false);
  assert.equal(claudeCodeRefusesBypassPermissions({}, undefined), false);
  assert.equal(claudeCodeRefusesBypassPermissions({ IS_SANDBOX: '1' }, 0), false);
  assert.equal(claudeCodeRefusesBypassPermissions({ IS_SANDBOX: 'true' }, 0), true);
  assert.equal(claudeCodeRefusesBypassPermissions({ CLAUDE_CODE_BUBBLEWRAP: 'true' }, 0), false);
  assert.equal(claudeCodeRefusesBypassPermissions({ CLAUDE_CODE_BUBBLEWRAP: '0' }, 0), true);
});

test('a managed run without an effort choice launches at the catalog default', { concurrency: false }, async () => {
  const managedDefault = await run('ECHO_FLAGS', 'effort-managed-default', { effort: 'default' }, { env: MANAGED });
  assert.match(managedDefault.texts[0], /^effort=max /);
  const managedMissing = await run('ECHO_FLAGS', 'effort-managed-missing', {}, { env: MANAGED });
  assert.match(managedMissing.texts[0], /^effort=max /);
  const managedExplicit = await run('ECHO_FLAGS', 'effort-managed-explicit', { effort: 'low' }, { env: MANAGED });
  assert.match(managedExplicit.texts[0], /^effort=low /);

  // Other installs keep leaving the default to Claude Code itself.
  const unmanaged = await run('ECHO_FLAGS', 'effort-unmanaged-default', { effort: 'default' });
  assert.match(unmanaged.texts[0], /^effort=none /);
});

test('full access launches in bypassPermissions without the switch-later flag', { concurrency: false }, async () => {
  const result = await run('ECHO_FLAGS', 'bypass-launch', { permissionMode: 'bypassPermissions' }, { env: MANAGED, uid: 1000 });
  assert.match(result.texts[0], / permission-mode=bypassPermissions allow-dangerously-skip=false$/);
  assert.deepEqual(result.errors, []);
});

test('full access as root falls back to default with a notice instead of a bare exit', { concurrency: false }, async () => {
  const result = await run('ECHO_FLAGS', 'bypass-root', { permissionMode: 'bypassPermissions' }, { env: MANAGED, uid: 0 });
  assert.match(result.texts[0], / permission-mode=default /);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /runs as root outside a sandbox/);
  assert.equal(result.sent.filter((message) => message.kind === 'complete').length, 1);

  const sandboxed = await run('ECHO_FLAGS', 'bypass-root-sandboxed', { permissionMode: 'bypassPermissions' }, {
    env: { ...MANAGED, IS_SANDBOX: '1' }, uid: 0,
  });
  assert.match(sandboxed.texts[0], / permission-mode=bypassPermissions /);
  assert.deepEqual(sandboxed.errors, []);
});

test('a question asked in full access mode still waits for the user\'s answer', { concurrency: false }, async () => {
  const result = await run('ASK_USER', 'bypass-question', { permissionMode: 'bypassPermissions' }, {
    env: MANAGED,
    uid: 1000,
    onSend: (message) => {
      if (message.kind !== 'permission_request') return;
      assert.equal(message.toolName, 'AskUserQuestion');
      const input = message.input as AnyRecord;
      // Answered the way the UI does: later, over another socket.
      setImmediate(() => claudeRuntime.permissions.resolve(String(message.requestId), {
        allow: true,
        updatedInput: { ...input, answers: { 'Pick a color': 'blue' } },
      }));
    },
  });
  assert.equal(result.sent.filter((message) => message.kind === 'permission_request').length, 1);
  assert.ok(result.sent.some((message) => message.kind === 'permission_resolved'));
  assert.deepEqual(result.texts, ['allow: {"Pick a color":"blue"}']);
});
