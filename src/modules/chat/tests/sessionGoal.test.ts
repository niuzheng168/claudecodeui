// Exercise persisted goal reads independently of transcript and composer state.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useSessionGoal } from '@/modules/chat/hooks/useSessionGoal';
import { api } from '@/shared/api';
import type { CodexSessionGoal, ServerEvent } from '@/shared/types';

const live = vi.hoisted(() => ({
  listeners: new Set<(event: ServerEvent) => void>(),
  subscribe: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: live.subscribe, sendMessage: live.send }),
}));

const activeGoal: CodexSessionGoal = {
  objective: 'Build the desktop and mobile UI\nthen test the demo.',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 324672,
  timeUsedSeconds: 3140,
};
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const tick = async (milliseconds = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
};
const emit = (event: ServerEvent) => {
  act(() => { for (const listener of live.listeners) listener(event); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  live.listeners.clear();
  live.send.mockClear();
  live.subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  });
  vi.spyOn(api.commands, 'goal').mockImplementation(async () => json({ goal: activeGoal }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('opening a session reads its persisted active goal without a local run or transcript event', async () => {
  const view = renderHook(() => useSessionGoal('desktop-session', true));
  await tick();
  expect(view.result.current.goal).toEqual(activeGoal);
  expect(view.result.current.error).toBeNull();
  expect(api.commands.goal).toHaveBeenCalledExactlyOnceWith('desktop-session', 'status', { signal: expect.any(AbortSignal) });
  expect(live.send).not.toHaveBeenCalled();
});

test('active goals refresh native usage and status without treating a completed turn as goal completion', async () => {
  const view = renderHook(() => useSessionGoal('a', true));
  await tick();
  vi.mocked(api.commands.goal).mockResolvedValueOnce(json({ goal: { ...activeGoal, tokensUsed: 400000, timeUsedSeconds: 3200 } }));
  await tick(5000);
  expect(view.result.current.goal).toMatchObject({ tokensUsed: 400000, timeUsedSeconds: 3200 });
  emit({ kind: 'complete', sessionId: 'a' });
  await tick(1000);
  expect(view.result.current.goal?.status).toBe('active');
  vi.mocked(api.commands.goal).mockResolvedValueOnce(json({ goal: { ...activeGoal, status: 'complete' } }));
  await tick(5000);
  expect(view.result.current.goal?.status).toBe('complete');
  const count = vi.mocked(api.commands.goal).mock.calls.length;
  await tick(5000);
  expect(api.commands.goal).toHaveBeenCalledTimes(count);
});

test('a session without a goal can discover one started elsewhere and clears only on a native null', async () => {
  vi.mocked(api.commands.goal).mockResolvedValueOnce(json({ goal: null }));
  const view = renderHook(() => useSessionGoal('a', true));
  await tick();
  expect(view.result.current.goal).toBeNull();
  expect(view.result.current.error).toBeNull();
  await tick(30000);
  expect(view.result.current.goal).toEqual(activeGoal);
  vi.mocked(api.commands.goal).mockResolvedValueOnce(json({ goal: null }));
  await tick(5000);
  expect(view.result.current.goal).toBeNull();
});

test('foreign events and read-generated task notifications never trigger goal reads', async () => {
  renderHook(() => useSessionGoal('a', true));
  await tick();
  for (const kind of ['chat_subscribed', 'complete', 'session_upserted', 'history_truncated']) {
    emit({ kind, sessionId: 'b' });
  }
  emit({ kind: 'task_notification', sessionId: 'a', summary: 'Goal: active' });
  await tick(1000);
  expect(api.commands.goal).toHaveBeenCalledTimes(1);
});

test('reconnects and viewed-session changes refresh promptly while bursts are coalesced', async () => {
  renderHook(() => useSessionGoal('a', true));
  await tick();
  for (let index = 0; index < 10; index++) {
    emit({ kind: 'session_upserted', sessionId: 'a' });
    emit({ kind: 'chat_subscribed', sessionId: 'a', isProcessing: false });
  }
  expect(api.commands.goal).toHaveBeenCalledTimes(1);
  await tick(1000);
  expect(api.commands.goal).toHaveBeenCalledTimes(2);
  emit({ kind: 'websocket_reconnected' });
  await tick(1000);
  expect(api.commands.goal).toHaveBeenCalledTimes(3);
});

test('events during a pending read request one follow-up rather than overlapping reads', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(api.commands.goal).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = renderHook(() => useSessionGoal('a', true));
  emit({ kind: 'complete', sessionId: 'a' });
  emit({ kind: 'websocket_reconnected' });
  await tick(1000);
  expect(api.commands.goal).toHaveBeenCalledTimes(1);
  await act(async () => finish(json({ goal: null })));
  expect(view.result.current.goal).toBeNull();
  await tick(1000);
  expect(api.commands.goal).toHaveBeenCalledTimes(2);
  expect(view.result.current.goal).toEqual(activeGoal);
});

test('navigation aborts old reads and never flashes or adopts another session goal, including A-B-A', async () => {
  let finishOld!: (response: Response) => void;
  vi.mocked(api.commands.goal).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const view = renderHook(({ sessionId }) => useSessionGoal(sessionId, true), { initialProps: { sessionId: 'a' } });
  const oldSignal = vi.mocked(api.commands.goal).mock.calls[0][2]!.signal!;
  view.rerender({ sessionId: 'b' });
  expect(oldSignal.aborted).toBe(true);
  expect(view.result.current.goal).toBeNull();
  await tick();
  expect(view.result.current.goal).toEqual(activeGoal);
  vi.mocked(api.commands.goal).mockResolvedValueOnce(json({ goal: { ...activeGoal, objective: 'New A', status: 'paused' } }));
  view.rerender({ sessionId: 'a' });
  expect(view.result.current.goal).toBeNull();
  await tick();
  await act(async () => finishOld(json({ goal: { ...activeGoal, objective: 'Stale A' } })));
  expect(view.result.current.goal).toMatchObject({ objective: 'New A', status: 'paused' });
});

test('non-Codex/new sessions and hidden chat panes do not poll', async () => {
  const view = renderHook(({ sessionId, isActive }) => useSessionGoal(sessionId, isActive), {
    initialProps: { sessionId: null as string | null, isActive: true },
  });
  await tick(30000);
  expect(api.commands.goal).not.toHaveBeenCalled();
  view.rerender({ sessionId: 'a', isActive: false });
  await tick(30000);
  expect(api.commands.goal).not.toHaveBeenCalled();
  view.rerender({ sessionId: 'a', isActive: true });
  await tick();
  expect(api.commands.goal).toHaveBeenCalledTimes(1);
  view.rerender({ sessionId: null, isActive: true });
  expect(view.result.current.goal).toBeNull();
  await tick(30000);
  expect(api.commands.goal).toHaveBeenCalledTimes(1);
});

test('background tabs stop polling and returning to the tab refreshes the snapshot', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  renderHook(() => useSessionGoal('a', true));
  await tick(30000);
  expect(api.commands.goal).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await tick();
  expect(api.commands.goal).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await tick(30000);
  expect(api.commands.goal).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('visible');
  act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  expect(api.commands.goal).toHaveBeenCalledTimes(2);
});

test('a failed refresh preserves the confirmed goal with an error, and a retry clears the error', async () => {
  const view = renderHook(() => useSessionGoal('a', true));
  await tick();
  vi.mocked(api.commands.goal).mockRejectedValueOnce(new Error('Offline'));
  await tick(5000);
  expect(view.result.current.goal).toEqual(activeGoal);
  expect(view.result.current.error).toBe('unavailable');
  act(() => view.result.current.refresh());
  await tick(1000);
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.goal).toEqual(activeGoal);
});

test.each([
  [new Response('<html>Not found</html>', { status: 404 }), 'unsupported'],
  [json({ code: 'SESSION_NOT_FOUND' }, 404), 'unavailable'],
  [json({ goal: { ...activeGoal, status: 'invented' } }), 'unavailable'],
  [json({ goal: { ...activeGoal, tokenBudget: 0 } }), 'unavailable'],
  [json({ goal: { ...activeGoal, timeUsedSeconds: -1 } }), 'unavailable'],
  [json({ message: 'Missing goal field' }), 'unavailable'],
])('unsupported or malformed replies are not presented as an absent or active goal', async (response, error) => {
  vi.mocked(api.commands.goal).mockResolvedValueOnce(response as Response);
  const view = renderHook(() => useSessionGoal('a', true));
  await tick();
  expect(view.result.current.error).toBe(error);
  expect(view.result.current.goal).toBeNull();
});

test('hung reads time out and unmount removes timers, listeners and the pending request', async () => {
  vi.mocked(api.commands.goal).mockImplementation((_sessionId, _command, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const view = renderHook(() => useSessionGoal('a', true));
  await tick(15000);
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.error).toBe('unavailable');
  act(() => view.result.current.refresh());
  const signal = vi.mocked(api.commands.goal).mock.calls.at(-1)![2]!.signal!;
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(live.listeners.size).toBe(0);
  const count = vi.mocked(api.commands.goal).mock.calls.length;
  await tick(60000);
  expect(api.commands.goal).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
