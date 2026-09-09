import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSteering } from '@/modules/chat/hooks/useChatSteering';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ServerEvent } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  connected: true,
  listeners: new Set<(event: ServerEvent) => void>(),
  send: vi.fn(),
  steerQueued: vi.fn(),
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/shared/api', () => ({ api: { user: { steerQueuedDraft: mocks.steerQueued } } }));
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

test('legacy nodes report an upgrade requirement instead of silently hiding steering', async () => {
  const view = renderHook(() => useChatSteering('a'));
  expect(view.result.current.unavailableReason).toBe('input.steer.checking');
  emit({ kind: 'chat_subscribed', sessionId: 'a', isProcessing: true, lastSeq: 12 });
  expect(view.result.current.canSteer).toBe(false);
  expect(view.result.current.unavailableReason).toBe('input.steer.upgradeRequired');
  await expect(view.result.current.steerMessage('a', 'Do not queue this', [])).rejects.toThrow('STEER_UNAVAILABLE');
  expect(mocks.send).not.toHaveBeenCalled();
  emit({ kind: 'complete', sessionId: 'a' });
  emit({ kind: 'status', sessionId: 'a', status: 'running' });
  expect(view.result.current.unavailableReason).toBe('input.steer.upgradeRequired');
  // A fresh capability after a node update restores the existing action.
  emit({ kind: 'chat_subscribed', sessionId: 'a', isProcessing: true, canSteer: true, runId: 'upgraded-run' });
  expect(view.result.current.canSteer).toBe(true);
  expect(view.result.current.unavailableReason).toBeNull();
});

test('a modern unsupported runtime is distinguished from an outdated node and another session', () => {
  const view = renderHook(({ sessionId }) => useChatSteering(sessionId), { initialProps: { sessionId: 'a' } });
  emit({ kind: 'chat_subscribed', sessionId: 'a', isProcessing: true, canSteer: false, runId: 'sdk-run' });
  expect(view.result.current.canSteer).toBe(false);
  expect(view.result.current.unavailableReason).toBe('input.steer.unavailable');
  view.rerender({ sessionId: 'b' });
  expect(view.result.current.unavailableReason).toBe('input.steer.checking');
  emit({ kind: 'chat_subscribed', sessionId: 'b', isProcessing: true });
  expect(view.result.current.unavailableReason).toBe('input.steer.upgradeRequired');
  view.rerender({ sessionId: 'a' });
  expect(view.result.current.unavailableReason).toBe('input.steer.unavailable');
});

test('a capability without a run token cannot enable a potentially misdirected correction', () => {
  const view = renderHook(() => useChatSteering('a'));
  emit({ kind: 'status', sessionId: 'a', canSteer: true });
  expect(view.result.current.canSteer).toBe(false);
  expect(view.result.current.unavailableReason).toBe('input.steer.upgradeRequired');
});

test('disconnects invalidate capabilities even before a reconnect notification', () => {
  const view = activeSteering();
  mocks.connected = false;
  view.rerender();
  expect(view.result.current.unavailableReason).toBe('input.steer.disconnected');
  mocks.connected = true;
  view.rerender();
  expect(view.result.current.canSteer).toBe(false);
  expect(view.result.current.unavailableReason).toBe('input.steer.checking');
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

test('queued promotion needs its own negotiated capability, not just native steering', async () => {
  const view = activeSteering();
  expect(view.result.current.canSteerQueued).toBe(false);
  expect(view.result.current.queuedUnavailableReason).toBe('input.steer.upgradeRequired');
  await expect(view.result.current.steerMessage('a', 'queued', [], { id: 'q', content: 'queued' })).rejects.toThrow('upgradeRequired');
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.steerQueued).not.toHaveBeenCalled();
  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-a' });
  expect(view.result.current.canSteerQueued).toBe(true);
  expect(view.result.current.queuedUnavailableReason).toBeNull();
});

test('native-only nodes show the queue upgrade requirement without a hover or unsafe fallback', async () => {
  const receipt = { id: 'queued-1', content: 'A queued instruction', attachments: [] };
  let submission: Promise<void> | undefined;
  mocks.steerQueued.mockImplementation(async (scope, request) => new Response(JSON.stringify({
    kind: 'chat_steer_result', sessionId: scope, requestId: request.requestId, accepted: true,
  })));
  function QueuedSteeringCard() {
    const steering = useChatSteering('a');
    return (
      <QueuedMessageCard content={receipt.content} onEdit={() => {}} onDelete={() => {}}
        canSteer={steering.canSteerQueued} steerUnavailableReason={steering.queuedUnavailableReason}
        onSteer={() => { submission = steering.steerMessage('a', receipt.content, [], receipt); }} />
    );
  }
  render(<QueuedSteeringCard />);
  // Matches the running node: native steering exists, but atomic queued promotion does not.
  emit({ kind: 'chat_subscribed', sessionId: 'a', isProcessing: true, canSteer: true, runId: 'run-a' });
  const button = screen.getByRole('button', { name: 'input.steer.send' }) as HTMLButtonElement;
  const explanation = screen.getByText('input.steer.upgradeRequired');
  expect(button.disabled).toBe(true);
  expect(button.getAttribute('aria-describedby')).toBe(explanation.id);
  fireEvent.click(button);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.steerQueued).not.toHaveBeenCalled();

  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-a' });
  expect(button.disabled).toBe(false);
  expect(screen.queryByText('input.steer.upgradeRequired')).toBeNull();
  fireEvent.click(button);
  await act(async () => { await submission; });
  expect(mocks.steerQueued).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
});

test('queued promotion uses the authenticated HTTP receipt and the originally captured run, never chat.send', async () => {
  mocks.steerQueued.mockImplementation(async (scope, request) => new Response(JSON.stringify({
    kind: 'chat_steer_result', sessionId: scope, requestId: request.requestId, accepted: true,
  })));
  const view = activeSteering();
  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-a' });
  const steer = view.result.current.steerMessage;
  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-new' });
  const queuedMessage = { id: 'q', content: 'Queued text', attachments: [{ name: 'notes.txt' }] };
  await steer('a', queuedMessage.content, queuedMessage.attachments, queuedMessage);
  expect(mocks.steerQueued).toHaveBeenCalledWith('a', {
    requestId: expect.any(String), expectedRunId: 'run-a', queuedMessage,
  }, expect.any(AbortSignal));
  expect(mocks.send).not.toHaveBeenCalled();
});

test.each([404, 501])('an older HTTP endpoint (%i) leaves the queue alone with no unsafe WS fallback', async (status) => {
  mocks.steerQueued.mockResolvedValue(new Response('{}', { status }));
  const view = activeSteering();
  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-a' });
  await expect(view.result.current.steerMessage('a', 'queued', [], { content: 'queued' })).rejects.toThrow('upgradeRequired');
  expect(mocks.steerQueued).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
});

test('queued refusal preserves native failure metadata for review rather than allowing auto-retry', async () => {
  mocks.steerQueued.mockImplementation(async (scope, request) => new Response(JSON.stringify({
    sessionId: scope, requestId: request.requestId, accepted: false, queueHeld: true, code: 'TIMEOUT',
  })));
  const view = activeSteering();
  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-a' });
  await expect(view.result.current.steerMessage('a', 'queued', [], { content: 'queued' })).rejects.toMatchObject({
    queueHeld: true, message: 'input.queue.reviewHint',
  });
  expect(mocks.send).not.toHaveBeenCalled();
});

test('a queued HTTP timeout aborts only the request and ignores a late response', async () => {
  vi.useFakeTimers();
  let respond!: (response: Response) => void;
  mocks.steerQueued.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
  const view = activeSteering();
  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-a' });
  const pending = view.result.current.steerMessage('a', 'queued', [], { content: 'queued' });
  const rejection = expect(pending).rejects.toMatchObject({ queueHeld: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await rejection;
  expect(mocks.steerQueued.mock.calls[0][2].aborted).toBe(true);
  respond(new Response(JSON.stringify({
    sessionId: 'a', requestId: mocks.steerQueued.mock.calls[0][1].requestId, accepted: true,
  })));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(mocks.steerQueued).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
});

test('a mismatched HTTP acknowledgement is unconfirmed rather than consuming another queue', async () => {
  mocks.steerQueued.mockResolvedValue(new Response(JSON.stringify({
    sessionId: 'other', requestId: 'other', accepted: true,
  })));
  const view = activeSteering();
  emit({ kind: 'status', sessionId: 'a', canSteer: true, canSteerQueued: true, runId: 'run-a' });
  await expect(view.result.current.steerMessage('a', 'queued', [], { content: 'queued' })).rejects.toMatchObject({ queueHeld: true });
  expect(mocks.send).not.toHaveBeenCalled();
});
