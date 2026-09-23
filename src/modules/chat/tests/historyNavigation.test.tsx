import { act, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { createSessionHistoryCache } from '@/shared/utils';
import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

const historyRequest = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { providers: {
    sessionMessages: (...args: unknown[]) => historyRequest(...args),
    sessionTokenUsage: async () => ({ ok: true, json: async () => ({ data: null }) }),
  } },
}));

const project = { projectId: 'project', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false } as Project;
const noop = () => {};
const session = (id: string) => ({ id } as ProjectSession);
const rows = (sessionId: string, count: number): NormalizedMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `${sessionId}-${index}`, sessionId, kind: 'tool_use', provider: 'codex',
  toolName: 'Bash', toolId: `tool-${index}`, toolInput: { command: 'pwd' },
  timestamp: '2026-09-19T00:00:00.000Z',
  nativePosition: { turnId: 'turn', turnStartedAt: '2026-09-19T00:00:00.000Z', itemIndex: index },
}));

function setup(owner: string | null = null, height = 500) {
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };
  const view = renderHook(({ selected }: { selected: ProjectSession }) => {
    const store = useSessionStore(owner);
    const state = useChatSessionState({
      isActive: true, selectedProject: project, selectedSession: selected, ws: null,
      sendMessage: noop, resetStreamingState: noop, statusCheckSentAtRef, lastSeqRef, sessionStore: store,
    });
    return { store, state };
  }, { initialProps: { selected: session('a') } });
  const container = document.createElement('div');
  Object.defineProperties(container, { scrollHeight: { value: height }, clientHeight: { value: 500 } });
  (view.result.current.state.scrollContainerRef as { current: HTMLDivElement }).current = container;
  return { ...view, container };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', noop);
  historyRequest.mockReset();
  historyRequest.mockImplementation(async (id, options) => {
    const history = rows(id, id === 'a' ? 181 : 10);
    const end = options.before ? history.findIndex(message => message.id === options.before) : Math.max(0, history.length - (options.offset ?? 0));
    const start = options.limit == null ? 0 : Math.max(0, end - options.limit);
    return { ok: true, json: async () => ({ data: {
      messages: history.slice(start, end), total: history.length, hasMore: start > 0,
      offset: history.length - end, snapshotId: `snapshot-${id}`,
      ...(options.before ? { before: options.before } : {}),
    } }) };
  });
});
afterEach(() => vi.unstubAllGlobals());

test('repeated upward gestures reach the first row even when every fetched page collapses into one tool group', async () => {
  const { result, container } = setup();
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(20));
  for (let page = 0; page < 9; page++) {
    container.scrollTop = 0;
    await act(async () => { result.current.state.handleHistoryScrollIntent(); });
    expect(result.current.state.isLoadingMoreMessages).toBe(false);
  }
  expect(result.current.state.hasMoreMessages).toBe(false);
  expect(result.current.state.chatMessages.length).toBe(181);
  expect(result.current.store.getMessages('a')[0].id).toBe('a-0');
  expect(historyRequest).toHaveBeenCalledTimes(10);
  expect(historyRequest.mock.calls.slice(1).every(([, options]) => options.before && options.snapshotId)).toBe(true);
});

test('switching A → B → A preserves all older pages, the render window and the reading position without another history request', async () => {
  const { result, rerender, container } = setup(null, 5000);
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(20));
  for (let page = 0; page < 6; page++) await act(async () => { await result.current.state.loadEarlierMessages(); });
  const count = result.current.state.chatMessages.length;
  const visible = result.current.state.visibleMessageCount;
  container.scrollTop = 150;
  await act(async () => { await result.current.state.handleScroll(); });
  // Staying in the same scrolled-up boolean must still save subsequent movement.
  container.scrollTop = 350;
  await act(async () => { await result.current.state.handleScroll(); });
  act(() => rerender({ selected: session('b') }));
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(10));
  const requests = historyRequest.mock.calls.length;
  act(() => rerender({ selected: session('a') }));
  await waitFor(() => expect(result.current.state.isLoadingSessionMessages).toBe(false));
  expect(historyRequest.mock.calls.length).toBe(requests);
  expect(result.current.state.chatMessages.length).toBe(count);
  expect(result.current.state.visibleMessageCount).toBe(visible);
  expect(container.scrollTop).toBe(350);
  expect(result.current.state.isUserScrolledUp).toBe(true);
  expect(result.current.store.getSessionSlot('a')?.serverMessages.length).toBe(count);
});

test('browser remount restores fetched history from IndexedDB without redownloading it', async () => {
  const first = setup('owner');
  await waitFor(() => expect(first.result.current.state.chatMessages.length).toBe(20));
  await act(async () => {
    await first.result.current.state.loadEarlierMessages();
    await first.result.current.state.loadEarlierMessages();
  });
  await waitFor(async () => expect((await createSessionHistoryCache('owner').read('a'))?.messages.length).toBe(60));
  first.unmount();
  historyRequest.mockClear();
  const second = setup('owner');
  await waitFor(() => expect(second.result.current.state.chatMessages.length).toBe(60));
  expect(historyRequest).not.toHaveBeenCalled();
  expect(second.result.current.state.hasMoreMessages).toBe(true);
  await act(async () => { await second.result.current.state.loadEarlierMessages(); });
  expect(second.result.current.state.chatMessages.length).toBe(80);
});

test('a failed page clears loading, retains older data, and succeeds on explicit retry', async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(20));
  historyRequest.mockRejectedValueOnce(new Error('temporary offline'));
  await act(async () => { await result.current.state.loadEarlierMessages(); });
  expect(result.current.state.isLoadingMoreMessages).toBe(false);
  expect(result.current.state.hasMoreMessages).toBe(true);
  expect(result.current.state.historyError).toContain('offline');
  expect(result.current.state.chatMessages.length).toBe(20);
  await act(async () => { await result.current.state.loadEarlierMessages(); });
  expect(result.current.state.chatMessages.length).toBe(40);
  expect(result.current.state.historyError).toBeNull();
});

test('a late older-page result from A cannot change B’s pagination, spinner or viewport', async () => {
  const { result, rerender } = setup();
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(20));
  let release!: (response: unknown) => void;
  historyRequest.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let reading: Promise<boolean>;
  act(() => { reading = result.current.state.loadEarlierMessages(); });
  await waitFor(() => expect(result.current.state.isLoadingMoreMessages).toBe(true));
  act(() => rerender({ selected: session('b') }));
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(10));
  await act(async () => {
    release({ ok: true, json: async () => ({ data: {
      messages: rows('a', 161).slice(-20), total: 181, hasMore: true, offset: 20,
      snapshotId: 'snapshot-a', before: 'a-161',
    } }) });
    await reading;
  });
  expect(result.current.state.chatMessages.length).toBe(10);
  expect(result.current.state.totalMessages).toBe(10);
  expect(result.current.state.hasMoreMessages).toBe(false);
  expect(result.current.state.isLoadingMoreMessages).toBe(false);
  expect(result.current.store.getSessionSlot('a')?.serverMessages.length).toBe(40);
});

test('load-all failures never mark a partial transcript complete', async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(20));
  historyRequest.mockRejectedValueOnce(new Error('native history unavailable'));
  await act(async () => { await result.current.state.loadAllMessages(); });
  expect(result.current.state.isLoadingAllMessages).toBe(false);
  expect(result.current.state.allMessagesLoaded).toBe(false);
  expect(result.current.state.hasMoreMessages).toBe(true);
  expect(result.current.state.chatMessages.length).toBe(20);
  expect(result.current.state.historyError).toContain('unavailable');
  await act(async () => { await result.current.state.loadAllMessages(); });
  expect(result.current.state.chatMessages.length).toBe(181);
  expect(result.current.state.hasMoreMessages).toBe(false);
});

test('an expired snapshot retries load-all once against fresh native history', async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(20));
  historyRequest.mockResolvedValueOnce({
    ok: false, status: 409,
    json: async () => ({ error: { code: 'HISTORY_SNAPSHOT_EXPIRED', message: 'Snapshot expired' } }),
  });
  await act(async () => { await result.current.state.loadAllMessages(); });
  expect(historyRequest.mock.calls.at(-2)?.[1].snapshotId).toBe('snapshot-a');
  expect(historyRequest.mock.calls.at(-1)?.[1].snapshotId).toBeUndefined();
  expect(result.current.state.chatMessages.length).toBe(181);
  expect(result.current.state.hasMoreMessages).toBe(false);
  expect(result.current.state.historyError).toBeNull();
});

test('a delayed load-all from A never marks B complete or changes B’s render window', async () => {
  const { result, rerender } = setup();
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(20));
  let release!: (response: unknown) => void;
  historyRequest.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let reading: Promise<void>;
  act(() => { reading = result.current.state.loadAllMessages(); });
  await waitFor(() => expect(result.current.state.isLoadingAllMessages).toBe(true));
  act(() => rerender({ selected: session('b') }));
  await waitFor(() => expect(result.current.state.chatMessages.length).toBe(10));
  await act(async () => {
    release({ ok: true, json: async () => ({ data: {
      messages: rows('a', 181), total: 181, hasMore: false, offset: 0, snapshotId: 'snapshot-a',
    } }) });
    await reading;
  });
  expect(result.current.state.totalMessages).toBe(10);
  expect(result.current.state.visibleMessageCount).toBe(100);
  expect(result.current.state.isLoadingAllMessages).toBe(false);
  act(() => rerender({ selected: session('a') }));
  expect(result.current.state.chatMessages.length).toBe(181);
  expect(result.current.state.hasMoreMessages).toBe(false);
});

test('switching accounts cannot join or restore the previous account’s in-flight same-ID history', async () => {
  let release!: (response: unknown) => void;
  historyRequest.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const refs = { statusCheckSentAtRef: { current: new Map<string, number>() }, lastSeqRef: { current: new Map<string, number>() } };
  const view = renderHook(({ owner }) => {
    const store = useSessionStore(owner);
    const state = useChatSessionState({
      isActive: true, selectedProject: project, selectedSession: session('a'),
      ws: null, sendMessage: noop, resetStreamingState: noop, ...refs, sessionStore: store,
    });
    return { store, state };
  }, { initialProps: { owner: 'account-a' } });
  await waitFor(() => expect(historyRequest).toHaveBeenCalledTimes(1));
  act(() => view.rerender({ owner: 'account-b' }));
  await waitFor(() => expect(view.result.current.state.chatMessages.length).toBe(20));
  expect(historyRequest).toHaveBeenCalledTimes(2);
  await act(async () => {
    release({ ok: true, json: async () => ({ data: {
      messages: rows('a', 60).slice(-20), total: 60, hasMore: true, offset: 0, snapshotId: 'old-account',
    } }) });
  });
  expect(view.result.current.state.totalMessages).toBe(181);
  expect(view.result.current.store.getSessionSlot('a')?.total).toBe(181);
  expect(await createSessionHistoryCache('account-a').read('a')).toBeNull();
  await waitFor(async () => expect((await createSessionHistoryCache('account-b').read('a'))?.total).toBe(181));
});
