import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { CodexProviderAuth, resolveCodexCustomProviderCredentials } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

function configureExecutable(t: TestContext, executable?: string): void {
  const previous = process.env.CODEY_CODEX_EXECUTABLE;
  if (executable === undefined) delete process.env.CODEY_CODEX_EXECUTABLE;
  else process.env.CODEY_CODEX_EXECUTABLE = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEY_CODEX_EXECUTABLE;
    else process.env.CODEY_CODEX_EXECUTABLE = previous;
  });
}

test('configured owner CLI is probed without an npm Codex dependency', (t) => {
  configureExecutable(t, process.execPath);
  t.mock.method(codexAppServer, 'resolveLauncher', () => { throw new Error('npm launcher must not be used'); });
  assert.deepEqual(new CodexProviderAuth().checkInstalled(), {
    installed: true, exitCode: 0, version: process.versions.node,
  });
});

test('relative configured executables are refused without searching PATH', (t) => {
  configureExecutable(t, 'codex');
  t.mock.method(codexAppServer, 'resolveLauncher', () => { throw new Error('unexpected fallback'); });
  assert.deepEqual(new CodexProviderAuth().checkInstalled(), {
    installed: false, exitCode: null, version: null,
  });
});

test('a missing configured owner CLI is not hidden by the npm fallback', (t) => {
  configureExecutable(t, path.join(os.tmpdir(), 'codey-absent-cli-probe', 'codex'));
  t.mock.method(codexAppServer, 'resolveLauncher', () => { throw new Error('unexpected fallback'); });
  assert.equal(new CodexProviderAuth().checkInstalled().installed, false);
});

test('standalone installations tolerate an absent npm launcher', (t) => {
  configureExecutable(t);
  t.mock.method(codexAppServer, 'resolveLauncher', () => { throw new Error('not installed'); });
  assert.deepEqual(new CodexProviderAuth().checkInstalled(), {
    installed: false, exitCode: null, version: null,
  });
});

const CUSTOM_PROVIDER_CONFIG = `
model_provider = "copilot_api"

[model_providers.copilot_api]
base_url = "http://localhost:4141"
env_key = "GITHUB_COPILOT_API_KEY"
requires_openai_auth = false
wire_api = "responses"
`;

test('Codex custom providers can authenticate without auth.json', () => {
  assert.deepEqual(
    resolveCodexCustomProviderCredentials(CUSTOM_PROVIDER_CONFIG, {
      GITHUB_COPILOT_API_KEY: 'configured',
    }),
    {
      authenticated: true,
      email: 'copilot_api',
      method: 'custom_provider',
    },
  );
});

test('Codex custom provider status names a missing environment key without revealing values', () => {
  assert.deepEqual(
    resolveCodexCustomProviderCredentials(CUSTOM_PROVIDER_CONFIG, {}),
    {
      authenticated: false,
      email: null,
      method: 'custom_provider',
      error: 'Missing GITHUB_COPILOT_API_KEY for Codex provider copilot_api',
    },
  );
});

test('providers requiring OpenAI auth continue to use the normal login flow', () => {
  assert.equal(
    resolveCodexCustomProviderCredentials(
      CUSTOM_PROVIDER_CONFIG.replace(
        'requires_openai_auth = false',
        'requires_openai_auth = true',
      ),
      { GITHUB_COPILOT_API_KEY: 'configured' },
    ),
    null,
  );
});
