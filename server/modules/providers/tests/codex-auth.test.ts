import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCodexCustomProviderCredentials } from '@/modules/providers/list/codex/codex-auth.provider.js';

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
