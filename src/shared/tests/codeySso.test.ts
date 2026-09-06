import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

test('SSO does not read/store/replay legacy browser JWTs', async () => {
  vi.stubEnv('VITE_CODEY_PORTAL_SSO', 'true');
  vi.resetModules();
  const auth = await import('@/shared/authToken');
  localStorage.setItem(auth.AUTH_TOKEN_STORAGE_KEY, 'header.payload.signature');
  expect(auth.getStoredAuthToken()).toBeNull();
  expect(auth.storeAuthToken('another.payload.signature')).toBe(false);
  const mock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', mock);
  const { authenticatedFetch } = await import('@/shared/api');
  await authenticatedFetch('/api/projects');
  expect(mock.mock.calls[0][1].headers.Authorization).toBeUndefined();
});
