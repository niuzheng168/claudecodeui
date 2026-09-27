import { afterEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';

afterEach(() => vi.unstubAllGlobals());

test('queue operations use a distinct endpoint so an old node cannot overwrite its single slot', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const operation = { kind: 'append' as const, message: { id: 'next', content: 'next message' } };
  const response = await api.user.saveDraft('session-a', { text: '', queueOperations: [operation] });
  expect(response.status).toBe(404);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/user/drafts/queue', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ scope: 'session-a', text: '', queueOperations: [operation] }),
  }));
  await api.user.saveDraft('session-a', { text: 'typing', preserveQueuedMessage: true });
  expect(fetch.mock.calls[1][0]).toBe('/api/user/drafts');
});
