import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { orderNativeTranscriptMessages } from '@/modules/chat/utils/nativeTranscriptOrder';
import type { NormalizedMessage } from '@/shared/types';

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

test('an expired native checkpoint adopts a bounded new tail, never offset-bridges incompatible cursor chains', async () => {
  read.mockResolvedValueOnce(response({ messages: [row(98), row(99)],
    total: 2, totalIsExact: false, hasMore: true, beforeCursor: 'np.old-before', syncCursor: 'np.old-after' }))
    .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'expired', code: 'HISTORY_SNAPSHOT_EXPIRED' }) })
    .mockResolvedValueOnce(response({ messages: [row(200), row(201)],
      total: 2, totalIsExact: false, hasMore: true, beforeCursor: 'np.new-before', syncCursor: 'np.new-after' }));
  const view = renderHook(() => useSessionStore());
  await act(async () => { await view.result.current.fetchFromServer('s', { limit: 20 }); });
  await act(async () => { await view.result.current.refreshLatestFromServer('s'); });
  expect(read.mock.calls).toHaveLength(3);
  expect(read.mock.calls[2][1]).toEqual({ limit: 20, offset: 0 });
  expect(view.result.current.getMessages('s').map(message => message.id)).toEqual(['row-200', 'row-201']);
  expect(view.result.current.getSessionSlot('s')?.beforeCursor).toBe('np.new-before');
});
