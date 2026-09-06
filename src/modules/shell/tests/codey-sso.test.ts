import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

test('SSO shell URL uses the portal cookie without query-string credentials', async () => {
  vi.stubEnv('VITE_CODEY_PORTAL_SSO', 'true');
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.resetModules();
  const { getShellWebSocketUrl } = await import('@/modules/shell/utils/socket');
  const url = getShellWebSocketUrl();
  expect(url).toContain('/shell');
  expect(url).not.toContain('token=');
});
