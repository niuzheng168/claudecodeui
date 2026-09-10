import assert from 'node:assert/strict';
import test from 'node:test';

import {
  providersForProfile,
  resolveCloudCliProviderProfile,
} from '@/modules/providers/provider-profile.js';

test('provider profiles keep full compatibility and a Codex-only mode', () => {
  assert.deepEqual(providersForProfile('full'), [
    'claude',
    'codex',
    'cursor',
    'opencode',
  ]);
  assert.deepEqual(providersForProfile('codex-only'), ['codex']);
});

test('provider profile defaults to full and rejects unknown values', () => {
  assert.equal(resolveCloudCliProviderProfile(undefined), 'full');
  assert.equal(resolveCloudCliProviderProfile(' codex-only '), 'codex-only');
  assert.throws(
    () => resolveCloudCliProviderProfile('claude-free-ish'),
    /Unsupported CLOUDCLI_PROVIDER_PROFILE/,
  );
});
