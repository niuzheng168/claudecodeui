import { expect, test } from 'vitest';

import { resolveProviderLoginCommand } from '@/modules/provider-auth/utils/providerLoginCommand';

test('Codey-managed Codex login uses the headless device flow', () => {
  expect(resolveProviderLoginCommand({
    provider: 'codex',
    isAuthenticated: false,
    useCodexDeviceAuth: true,
  })).toBe('codex login --device-auth');
});

test('ordinary local Codex login keeps the localhost callback flow', () => {
  expect(resolveProviderLoginCommand({
    provider: 'codex',
    isAuthenticated: false,
    useCodexDeviceAuth: false,
  })).toBe('codex login');
});

test('an explicit provider login command still takes precedence', () => {
  expect(resolveProviderLoginCommand({
    provider: 'codex',
    customCommand: 'custom-login',
    isAuthenticated: false,
    useCodexDeviceAuth: true,
  })).toBe('custom-login');
});
