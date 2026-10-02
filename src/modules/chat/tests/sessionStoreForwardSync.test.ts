import { act, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, SessionHistoryRequest } from '@/shared/types';
import { createSessionHistoryCache } from '@/shared/utils';

const sessionMessages = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { providers: { sessionMessages: (...args: unknown[]) => sessionMessages(...args) } },
}));

const rows: NormalizedMessage[] = Array.from({ length: 200 }, (_, index) => ({
  id: `row-${index}`, sessionId: 's', provider: 'codex', kind: 'text',
  role: 'assistant', content: `reply ${index}`, timestamp: '2026-10-02T00:00:00.000Z',
  nativePosition: { turnId: 'turn', turnStartedAt: '2026-10-02T00:00:00.000Z', itemIndex: index },
}));
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) });

function serve() {
  const state = { total: 50, beforePage: async (_options: SessionHistoryRequest) => {} };
  sessionMessages.mockImplementation(async (_id: string, options: SessionHistoryRequest) => {
    await state.beforePage(options);
    const start = options.after ? rows.findIndex(row => row.id === options.after) : state.total - 20;
    const end = options.after ? Math.min(state.total, start + (options.limit ?? 20)) : state.total;
    return response({
      messages: rows.slice(start, end), total: state.total, hasMore: start > 0,
      offset: state.total - end, snapshotId: 'snapshot',
      ...(options.after ? { after: options.after, hasNewer: end < state.total } : {}),
    });
  });
  return state;
}

async function open(owner: string | null = null) {
  const view = renderHook(() => useSessionStore(owner));
  view.result.current.setActiveSession('s');
  await act(async () => { await view.result.current.fetchFromServer('s', { limit: 20 }); });
  return view;
}

beforeEach(() => { sessionMessages.mockReset(); });

test('resuming publishes each bounded forward page before the next reply and keeps older row objects', async () => {
  const state = serve();
  const { result } = await open();
  const oldRow = result.current.getMessages('s')[0];
  state.total = 125;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.beforePage = async options => { if (options.after === 'row-68') await gate; };
  let refresh!: ReturnType<typeof result.current.refreshLatestFromServer>;
  act(() => { refresh = result.current.refreshLatestFromServer('s'); });
  await waitFor(() => expect(result.current.getMessages('s').at(-1)?.id).toBe('row-68'));
  expect(result.current.getMessages('s')[0]).toBe(oldRow);
  await act(async () => { release(); await refresh; });
  expect(result.current.getMessages('s').map(row => row.id)).toEqual(rows.slice(30, 125).map(row => row.id));
  expect(result.current.getSessionSlot('s')?.hasMore).toBe(true);
  expect(sessionMessages.mock.calls.slice(1).map(([, options]) => options.after))
    .toEqual(['row-49', 'row-68', 'row-87', 'row-106']);
  expect(sessionMessages.mock.calls.every(([, options]) => options.limit <= 20)).toBe(true);
});

test('each page is durable before the next HTTP reply, even without unmount or a completed catch-up', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    const state = serve();
    const view = await open('owner');
    state.total = 125;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.beforePage = async options => { if (options.after === 'row-68') await gate; };
    let refresh!: ReturnType<typeof view.result.current.refreshLatestFromServer>;
    act(() => { refresh = view.result.current.refreshLatestFromServer('s'); });
    await waitFor(async () => expect(
      (await createSessionHistoryCache('owner').read('s'))?.messages.at(-1)?.id,
    ).toBe('row-68'));
    // A separate browser instance sees that checkpoint while the original
    // page is still alive and waiting on the network: cleanup cannot mask it.
    const reopened = renderHook(() => useSessionStore('owner'));
    await act(async () => { await reopened.result.current.restoreFromCache('s'); });
    expect(reopened.result.current.getMessages('s').at(-1)?.id).toBe('row-68');
    expect(reopened.result.current.isStale('s')).toBe(true);
    await act(async () => { release(); await refresh; });
    view.unmount(); reopened.unmount();
  } finally { vi.unstubAllGlobals(); }
});

test('a hidden page flushes its latest viewport before the debounce fires, without waiting for unmount', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    serve();
    const view = await open('owner');
    const state = { visibleCount: 20, scrollTop: 234, scrolledUp: true, anchorId: 'row-31', anchorOffset: -15 };
    act(() => {
      view.result.current.saveView('s', state);
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(async () => expect((await createSessionHistoryCache('owner').read('s'))?.view).toEqual(state));
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

test('a remount carries the signed resume cursor after the snapshot is gone, with no tail redownload', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    await createSessionHistoryCache('owner').write({
      sessionId: 's', messages: rows.slice(30, 50), total: 50, offset: 20,
      hasMore: true, fetchedAt: Date.now() - 3600_000, syncCursor: 'signed-checkpoint',
    });
    sessionMessages.mockResolvedValue(response({
      messages: rows.slice(49, 55), total: 55, offset: 0, after: 'row-49', hasNewer: false,
      hasMore: true, syncCursor: 'new-checkpoint',
    }));
    const view = renderHook(() => useSessionStore('owner'));
    await act(async () => { await view.result.current.restoreFromCache('s'); });
    await act(async () => { await view.result.current.refreshLatestFromServer('s'); });
    expect(sessionMessages).toHaveBeenCalledTimes(1);
    expect(sessionMessages.mock.calls[0][1]).toEqual({
      limit: 20, offset: 0, snapshotId: undefined, after: 'row-49', syncCursor: 'signed-checkpoint',
    });
    expect(view.result.current.getMessages('s').at(-1)?.id).toBe('row-54');
    expect((await createSessionHistoryCache('owner').read('s'))?.syncCursor).toBe('new-checkpoint');
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});

test('partial forward progress survives suspension and restarts from the last confirmed row', async () => {
  const state = serve();
  const { result } = await open();
  state.total = 100;
  let active = true;
  state.beforePage = async options => { if (options.after) active = false; };
  await act(async () => {
    expect((await result.current.refreshLatestFromServer('s', { canRequest: () => active })).deferred).toBe(true);
  });
  expect(result.current.getMessages('s').at(-1)?.id).toBe('row-68');
  state.beforePage = async () => {};
  await act(async () => { await result.current.refreshLatestFromServer('s'); });
  expect(sessionMessages.mock.calls[2][1].after).toBe('row-68');
  expect(result.current.getMessages('s').map(row => row.id)).toEqual(rows.slice(30, 100).map(row => row.id));
});

test('a failed later page retains confirmed progress and exposes a retryable error', async () => {
  const state = serve();
  const { result } = await open();
  state.total = 100;
  state.beforePage = async options => { if (options.after === 'row-68') throw new Error('offline'); };
  await act(async () => {
    expect((await result.current.refreshLatestFromServer('s')).deferred).toBe(true);
  });
  expect(result.current.getMessages('s').at(-1)?.id).toBe('row-68');
  expect(result.current.getSessionSlot('s')?.historyError).toBe('offline');
  state.beforePage = async () => {};
  await act(async () => { await result.current.refreshLatestFromServer('s'); });
  expect(result.current.getSessionSlot('s')?.historyError).toBeUndefined();
  expect(result.current.getMessages('s')).toHaveLength(70);
});

test('a deleted anchor triggers a bounded authoritative reset, not a stale-history merge', async () => {
  serve();
  const { result } = await open();
  sessionMessages.mockImplementation(async (_id, options) => options.after
    ? { ok: false, json: async () => ({ error: { code: 'HISTORY_ANCHOR_NOT_FOUND' } }) }
    : response({ messages: rows.slice(0, 20), total: 20, hasMore: false, snapshotId: 'new' }));
  await act(async () => { await result.current.refreshLatestFromServer('s'); });
  expect(result.current.getMessages('s').map(row => row.id)).toEqual(rows.slice(0, 20).map(row => row.id));
  expect(result.current.getSessionSlot('s')?.hasMore).toBe(false);
});

test('an edit received during a forward request cannot be undone by its stale reply', async () => {
  const state = serve();
  const { result } = await open();
  const slot = result.current.getSessionSlot('s')!;
  // A real edit removes the row carrying its transcript anchor and the suffix.
  slot.serverMessages[10] = { ...slot.serverMessages[10], transcriptAnchorId: 'edit' };
  state.total = 100;
  state.beforePage = async options => { if (options.after) result.current.truncateAt('s', 'edit'); };
  await act(async () => {
    expect((await result.current.refreshLatestFromServer('s')).deferred).toBe(true);
  });
  expect(result.current.getMessages('s').map(row => row.id)).toEqual(rows.slice(30, 40).map(row => row.id));
});
