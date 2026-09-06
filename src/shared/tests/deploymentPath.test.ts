import { afterEach, expect, test } from 'vitest';

import {
  deploymentStorageKey,
  getDefaultProvider,
  getDeploymentBasePath,
  getEnabledProviders,
  resolveEnabledProvider,
  withDeploymentBasePath,
} from '@/shared/utils';

type DeploymentWindow = Window & { __CLOUDCLI_BASE_PATH__?: string };

afterEach(() => {
  delete (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__;
});

test('deployment paths keep ordinary root installs unchanged', () => {
  expect(getDeploymentBasePath()).toBe('/');
  expect(withDeploymentBasePath('/api/auth/status')).toBe('/api/auth/status');
  expect(deploymentStorageKey('auth-token')).toBe('auth-token');
});

test('deployment paths prefix Codey-owned HTTP and WebSocket routes once', () => {
  (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__ = '/cloudcli/linux-gpu/';

  expect(getDeploymentBasePath()).toBe('/cloudcli/linux-gpu/');
  expect(withDeploymentBasePath('/api/auth/status')).toBe(
    '/cloudcli/linux-gpu/api/auth/status',
  );
  expect(withDeploymentBasePath('/cloudcli/linux-gpu/ws')).toBe(
    '/cloudcli/linux-gpu/ws',
  );
  expect(deploymentStorageKey('auth-token')).toBe(
    'auth-token:cloudcli/linux-gpu',
  );
});

test('deployment paths do not rewrite external URLs', () => {
  (window as DeploymentWindow).__CLOUDCLI_BASE_PATH__ = '/cloudcli/linux-gpu/';

  expect(withDeploymentBasePath('https://example.test/api')).toBe(
    'https://example.test/api',
  );
  expect(withDeploymentBasePath('//cdn.example.test/app.js')).toBe(
    '//cdn.example.test/app.js',
  );
});

test('ordinary CloudCLI exposes every provider and starts with Claude', () => {
  expect(getEnabledProviders(false)).toEqual(['claude', 'cursor', 'codex', 'opencode']);
  expect(getDefaultProvider(false)).toBe('claude');
  expect(resolveEnabledProvider('cursor', false)).toBe('cursor');
});

test('Codey-managed workspaces expose only Codex and reject stale provider preferences', () => {
  expect(getEnabledProviders(true)).toEqual(['codex']);
  expect(getDefaultProvider(true)).toBe('codex');
  expect(resolveEnabledProvider('claude', true)).toBe('codex');
  expect(resolveEnabledProvider('codex', true)).toBe('codex');
});
