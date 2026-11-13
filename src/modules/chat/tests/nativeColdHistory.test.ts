import { act, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { orderNativeTranscriptMessages } from '@/modules/chat/utils/nativeTranscriptOrder';
import type { NormalizedMessage } from '@/shared/types';
import { createSessionHistoryCache } from '@/shared/utils';

const read = vi.fn();
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: (...args: unknown[]) => read(...args) } } }));
const row = (index: number): NormalizedMessage => ({
  id: `row-${index}`, provider: 'codex', sessionId: 's', kind: 'text', role: 'assistant',
  content: `message ${index}`, timestamp: '2026-10-03T00:00:00.000Z',
  nativePosition: { turnId: 'turn', turnStartedAt: '2026-10-03T00:00:00.000Z', itemIndex: index - 99, orderScope: 'page' },
});
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
beforeEach(() => { read.mockReset(); });

test('native older pages use their signed before cursor, not a whole-history tail-relative offset', async () => {
  read.mockResolvedValueOnce(response({ messages: Array.from({ length: 20 }, (_, i) => row(i + 80)),
    total: 20, totalIsExact: false, hasMore: true, beforeCursor: 'np.older', syncCursor: 'np.newer' }))
    .mockResolvedValueOnce(response({ messages: Array.from({ length: 20 }, (_, i) => row(i + 60)),
      total: 40, totalIsExact: false, hasMore: true, beforeCursor: 'np.older2', before: 'row-80' }));
  const view = renderHook(() => useSessionStore());
  await act(async () => { await view.result.current.fetchFromServer('s', { limit: 20 }); });
  await act(async () => { await view.result.current.fetchMore('s'); });
  expect(read.mock.calls[1][1]).toEqual({ limit: 20, offset: 0, before: 'row-80', beforeCursor: 'np.older' });
  expect(view.result.current.getMessages('s')).toHaveLength(40);
  expect(view.result.current.getSessionSlot('s')?.syncCursor).toBe('np.newer');
  expect(view.result.current.getSessionSlot('s')?.beforeCursor).toBe('np.older2');
});

test('page-local native positions align realtime items by shared identity instead of sorting live rows before history', () => {
  const stored = [row(98), row(99)];
  const live = [98, 99, 100].map(index => ({
    ...row(index), nativePosition: { ...row(index).nativePosition!, itemIndex: index, orderScope: undefined },
  }));
  const merged = orderNativeTranscriptMessages([...stored, live[2]], stored, live, () => 0);
  expect(merged.map(message => message.id)).toEqual(['row-98', 'row-99', 'row-100']);
});

test.each(['HISTORY_SNAPSHOT_EXPIRED', 'HISTORY_SNAPSHOT_MISMATCH', 'HISTORY_ANCHOR_NOT_FOUND'])(
  '%s during forward sync adopts a bounded new tail, never offset-bridges incompatible cursor chains',
  async code => {
    read.mockResolvedValueOnce(response({ messages: [row(98), row(99)],
      total: 2, totalIsExact: false, hasMore: true, beforeCursor: 'np.old-before', syncCursor: 'np.old-after' }))
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'stale checkpoint', code }) })
      .mockResolvedValueOnce(response({ messages: [row(200), row(201)],
        total: 2, totalIsExact: false, hasMore: true, beforeCursor: 'np.new-before', syncCursor: 'np.new-after' }));
    const view = renderHook(() => useSessionStore());
    await act(async () => { await view.result.current.fetchFromServer('s', { limit: 20 }); });
    await act(async () => { await view.result.current.refreshLatestFromServer('s'); });
    expect(read.mock.calls).toHaveLength(3);
    expect(read.mock.calls[2][1]).toEqual({ limit: 20, offset: 0 });
    expect(view.result.current.getMessages('s').map(message => message.id)).toEqual(['row-200', 'row-201']);
    expect(view.result.current.getSessionSlot('s')?.beforeCursor).toBe('np.new-before');
    expect(view.result.current.getSessionSlot('s')?.historyError).toBeUndefined();
    expect(view.result.current.getSessionSlot('s')?.status).toBe('idle');
  },
);

test.each(['HISTORY_SNAPSHOT_EXPIRED', 'HISTORY_SNAPSHOT_MISMATCH', 'HISTORY_ANCHOR_NOT_FOUND'])(
  '%s on an older page resets the chain even when its forward checkpoint still works',
  async code => {
    read.mockImplementation(async (_id, options) => {
      if (options.beforeCursor === 'np.old-before') {
        return { ok: false, json: async () => ({ error: { code, message: 'stale older boundary' } }) };
      }
      if (options.after) {
        return response({ messages: [row(99)], total: 2, totalIsExact: false,
          after: options.after, hasNewer: false, syncCursor: 'np.old-after' });
      }
      if (options.beforeCursor === 'np.new-before') {
        return response({ messages: [row(197), row(198)], total: 2, totalIsExact: false,
          before: options.before, hasMore: true, beforeCursor: 'np.earlier' });
      }
      const firstRead = read.mock.calls.length === 1;
      return response({ messages: firstRead ? [row(98), row(99)] : [row(199), row(200)],
        total: 2, totalIsExact: false, hasMore: true,
        beforeCursor: firstRead ? 'np.old-before' : 'np.new-before',
        syncCursor: firstRead ? 'np.old-after' : 'np.new-after' });
    });
    const view = renderHook(() => useSessionStore());
    await act(async () => { await view.result.current.fetchFromServer('s', { limit: 20 }); });
    await act(async () => { await view.result.current.fetchMore('s'); });
    expect(read.mock.calls).toHaveLength(3);
    expect(read.mock.calls[2][1]).toEqual({ limit: 20, offset: 0 });
    expect(view.result.current.getSessionSlot('s')?.beforeCursor).toBe('np.new-before');
    expect(view.result.current.getSessionSlot('s')?.syncCursor).toBe('np.new-after');
    expect(view.result.current.getSessionSlot('s')?.historyError).toBeUndefined();
    await act(async () => { await view.result.current.fetchMore('s'); });
    expect(read.mock.calls[3][1]).toEqual({ limit: 20, offset: 0, before: 'row-199', beforeCursor: 'np.new-before' });
    expect(view.result.current.getMessages('s').map(message => message.id))
      .toEqual(['row-197', 'row-198', 'row-199', 'row-200']);
  },
);

test('a failed checkpoint reset keeps confirmed history and retries without loading all messages', async () => {
  const stale = { ok: false, json: async () => ({
    error: { code: 'HISTORY_SNAPSHOT_MISMATCH', message: 'stale checkpoint' },
  }) };
  read.mockResolvedValueOnce(response({ messages: [row(98), row(99)],
    total: 2, totalIsExact: false, hasMore: true, beforeCursor: 'np.old-before', syncCursor: 'np.old-after' }))
    .mockResolvedValueOnce(stale)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(stale)
    .mockResolvedValueOnce(response({ messages: [row(200), row(201)],
      total: 2, totalIsExact: false, hasMore: true, beforeCursor: 'np.new-before', syncCursor: 'np.new-after' }));
  const view = renderHook(() => useSessionStore());
  await act(async () => { await view.result.current.fetchFromServer('s', { limit: 20 }); });
  const confirmed = view.result.current.getSessionSlot('s')!.serverMessages;
  await act(async () => { await view.result.current.fetchMore('s'); });
  expect(view.result.current.getSessionSlot('s')?.serverMessages).toBe(confirmed);
  expect(view.result.current.getSessionSlot('s')?.beforeCursor).toBe('np.old-before');
  expect(view.result.current.getSessionSlot('s')?.historyError).toBe('offline');
  await act(async () => { await view.result.current.fetchMore('s'); });
  expect(read.mock.calls).toHaveLength(5);
  expect(read.mock.calls.every(([, options]) => options.limit === 20 && (options.offset ?? 0) === 0)).toBe(true);
  expect(view.result.current.getMessages('s').map(message => message.id)).toEqual(['row-200', 'row-201']);
  expect(view.result.current.getSessionSlot('s')?.historyError).toBeUndefined();
});

test('a mismatched persisted checkpoint is replaced on disk so reopening does not repeat the error', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    const cache = createSessionHistoryCache('owner');
    await cache.write({
      sessionId: 's', messages: [row(98), row(99)], total: 2, offset: 2,
      fetchedAt: Date.now() - 60_000, hasMore: true, totalIsExact: false,
      beforeCursor: 'np.old-before', syncCursor: 'np.old-after',
    });
    read.mockResolvedValueOnce({ ok: false, json: async () => ({
      code: 'HISTORY_SNAPSHOT_MISMATCH', error: 'This native page cursor belongs to another session or boundary.',
    }) }).mockResolvedValueOnce(response({
      messages: [row(200), row(201)], total: 2, totalIsExact: false, hasMore: true,
      beforeCursor: 'np.new-before', syncCursor: 'np.new-after',
    })).mockResolvedValueOnce(response({
      messages: [row(201)], total: 1, totalIsExact: false, after: 'row-201',
      hasNewer: false, syncCursor: 'np.confirmed-after',
    }));
    const first = renderHook(() => useSessionStore('owner'));
    await act(async () => { await first.result.current.restoreFromCache('s'); });
    await act(async () => { await first.result.current.refreshLatestFromServer('s'); });
    await waitFor(async () => expect((await cache.read('s'))?.syncCursor).toBe('np.new-after'));
    first.unmount();
    const reopened = renderHook(() => useSessionStore('owner'));
    await act(async () => { await reopened.result.current.restoreFromCache('s'); });
    await act(async () => { await reopened.result.current.refreshLatestFromServer('s'); });
    expect(read.mock.calls).toHaveLength(3);
    expect(read.mock.calls[2][1]).toMatchObject({ after: 'row-201', syncCursor: 'np.new-after' });
    expect(reopened.result.current.getSessionSlot('s')?.beforeCursor).toBe('np.new-before');
    expect(reopened.result.current.getSessionSlot('s')?.historyError).toBeUndefined();
    reopened.unmount();
  } finally { vi.unstubAllGlobals(); }
});

test('an edit received while recovering a mismatched checkpoint fences the stale reset response', async () => {
  read.mockResolvedValueOnce(response({
    messages: [row(98), { ...row(99), transcriptAnchorId: 'edit' }], total: 2,
    totalIsExact: false, hasMore: true, beforeCursor: 'np.old-before', syncCursor: 'np.old-after',
  })).mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'HISTORY_SNAPSHOT_MISMATCH' }) });
  const view = renderHook(() => useSessionStore());
  await act(async () => { await view.result.current.fetchFromServer('s', { limit: 20 }); });
  read.mockImplementationOnce(async () => {
    view.result.current.truncateAt('s', 'edit');
    return response({ messages: [row(99), row(100)], total: 2, totalIsExact: false,
      hasMore: true, beforeCursor: 'np.stale-before', syncCursor: 'np.stale-after' });
  });
  await act(async () => {
    expect((await view.result.current.refreshLatestFromServer('s')).deferred).toBe(true);
  });
  expect(view.result.current.getMessages('s').map(message => message.id)).toEqual(['row-98']);
  expect(view.result.current.getSessionSlot('s')?.beforeCursor).toBeUndefined();
});
