import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSteering } from '@/modules/chat/hooks/useChatSteering';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ServerEvent } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  connected: true,
  listeners: new Set<(event: ServerEvent) => void>(),
  send: vi.fn(),
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    isConnected: mocks.connected,
    sendMessage: mocks.send,
    subscribe: (listener: (event: ServerEvent) => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  }),
}));

beforeEach(() => {
  mocks.connected = true;
  mocks.listeners.clear();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

function emit(event: ServerEvent) {
  act(() => { for (const listener of mocks.listeners) listener(event); });
}

function activeSteering() {
  const view = renderHook(() => useChatSteering('a'));
  emit({ kind: 'status', sessionId: 'a', canSteer: true, runId: 'run-a' });
  return view;
}

test('steering is advertised per live session and disappears on completion/disconnect', () => {
  const view = renderHook(({ sessionId }) => useChatSteering(sessionId), { initialProps: { sessionId: 'a' } });
  expect(view.result.current.canSteer).toBe(false);
  emit({ kind: 'status', sessionId: 'a', canSteer: true, runId: 'run-a' });
  expect(view.result.current.canSteer).toBe(true);
  view.rerender({ sessionId: 'b' });
  expect(view.result.current.canSteer).toBe(false);
  emit({ kind: 'chat_subscribed', sessionId: 'b', isProcessing: true, canSteer: true, runId: 'run-b' });
  expect(view.result.current.canSteer).toBe(true);
  emit({ kind: 'complete', sessionId: 'b' });
  expect(view.result.current.canSteer).toBe(false);
  view.rerender({ sessionId: 'a' });
  expect(view.result.current.canSteer).toBe(true);
  mocks.connected = false;
  view.rerender({ sessionId: 'a' });
  expect(view.result.current.canSteer).toBe(false);
  emit({ kind: 'websocket_reconnected' });
  mocks.connected = true;
  view.rerender({ sessionId: 'a' });
  expect(view.result.current.canSteer).toBe(false);
  emit({ kind: 'chat_subscribed', sessionId: 'a', isProcessing: true, canSteer: true, runId: 'new-run-a' });
  expect(view.result.current.canSteer).toBe(true);
});

test('only a matching session/request acknowledgement resolves a correction, even after navigation', async () => {
  const view = renderHook(({ sessionId }) => useChatSteering(sessionId), { initialProps: { sessionId: 'a' } });
  emit({ kind: 'status', sessionId: 'a', canSteer: true, runId: 'run-a' });
  const pending = view.result.current.steerMessage('a', 'Focus on tests', []);
  const frame = mocks.send.mock.calls[0][0];
  expect(frame).toMatchObject({ type: 'chat.steer', sessionId: 'a', content: 'Focus on tests', options: { attachments: [] } });
  let resolved = false;
  void pending.then(() => { resolved = true; });
  emit({ kind: 'chat_steer_result', sessionId: 'a', requestId: 'wrong-id', accepted: true });
  emit({ kind: 'chat_steer_result', sessionId: 'b', requestId: frame.requestId, accepted: true });
  await Promise.resolve();
  expect(resolved).toBe(false);
  view.rerender({ sessionId: 'b' });
  emit({ kind: 'chat_steer_result', sessionId: 'a', requestId: frame.requestId, accepted: true });
  await pending;
  expect(resolved).toBe(true);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('refused corrections reject explicitly without a send/abort fallback', async () => {
  const view = activeSteering();
  const pending = view.result.current.steerMessage('a', 'Focus on tests', []);
  const rejection = expect(pending).rejects.toThrow('Turn no longer active');
  emit({
    kind: 'chat_steer_result', sessionId: 'a', requestId: mocks.send.mock.calls[0][0].requestId,
    accepted: false, code: 'NO_ACTIVE_RUN', error: 'Turn no longer active',
  });
  await rejection;
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('rapid duplicate submissions and disconnected sends never go onto the wire', async () => {
  const view = activeSteering();
  const pending = view.result.current.steerMessage('a', 'Correction', []);
  const rejection = expect(pending).rejects.toThrow('unconfirmed');
  await expect(view.result.current.steerMessage('a', 'Correction', [])).rejects.toThrow('pending');
  expect(mocks.send).toHaveBeenCalledTimes(1);
  mocks.connected = false;
  view.rerender();
  await rejection;
  await expect(view.result.current.steerMessage('a', 'Correction', [])).rejects.toThrow('disconnected');
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('an acknowledgement timeout is ambiguous and never automatically retried', async () => {
  vi.useFakeTimers();
  const view = activeSteering();
  const pending = view.result.current.steerMessage('a', 'Correction', []);
  const rejection = expect(pending).rejects.toThrow('unconfirmed');
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await rejection;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('leaving the chat rejects the pending request and removes its timer', async () => {
  vi.useFakeTimers();
  const view = activeSteering();
  const pending = view.result.current.steerMessage('a', 'Correction', []);
  const rejection = expect(pending).rejects.toThrow('unconfirmed');
  view.unmount();
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});

test('steering acknowledgements never end/restart the activity indicator or append error rows', () => {
  let listener!: (event: ServerEvent) => void;
  const idle = vi.fn();
  const processing = vi.fn();
  const append = vi.fn();
  renderHook(() => useChatRealtimeHandlers({
    isActive: true, subscribe: (fn) => { listener = fn; return () => {}; },
    provider: 'codex', selectedSession: { id: 'a' }, currentSessionId: 'a',
    setTokenBudget: vi.fn(), pendingPermissionRequests: [], setPendingPermissionRequests: vi.fn(),
    streamTimerRef: { current: null }, accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() }, statusCheckSentAtRef: { current: new Map() },
    onSessionIdle: idle, onSessionProcessing: processing, requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: append } as unknown as SessionStore,
  }));
  act(() => {
    listener({ kind: 'chat_steer_result', sessionId: 'a', accepted: false, error: 'Refused' });
    listener({ kind: 'chat_steer_result', sessionId: 'a', accepted: true });
  });
  expect(idle).not.toHaveBeenCalled();
  expect(processing).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

test('uploads keep the original run token even if a newer turn starts before submission', async () => {
  const view = activeSteering();
  const beforeUpload = view.result.current.steerMessage;
  emit({ kind: 'status', sessionId: 'a', canSteer: true, runId: 'new-run' });
  const pending = beforeUpload('a', 'Correction for the original run', []);
  expect(mocks.send.mock.calls[0][0].expectedRunId).toBe('run-a');
  const rejection = expect(pending).rejects.toThrow('Running turn changed');
  emit({
    kind: 'chat_steer_result', sessionId: 'a', requestId: mocks.send.mock.calls[0][0].requestId,
    accepted: false, code: 'STEER_STALE_RUN', error: 'Running turn changed',
  });
  await rejection;
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
