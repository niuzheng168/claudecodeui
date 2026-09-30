import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

const auth = vi.hoisted(() => ({
  isLoading: false, token: null as string | null, user: { id: 'owner' } as { id: string } | null,
}));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/utils', () => ({
  IS_PLATFORM: false,
  isCodeyPortalSso: () => true,
  deploymentStorageKey: (value: string) => 'reconnect-test-' + value,
  returnToCodeyLogin: vi.fn(),
  withDeploymentBasePath: (value: string) => '/workspace/node' + value,
}));

class TestSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static sockets: TestSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) { TestSocket.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(value: string) { this.sent.push(value); }
}

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(WebSocketProvider, null, children);

function visibility(state: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.isLoading = false;
  auth.token = null;
  auth.user = { id: 'owner' };
  TestSocket.sockets = [];
  vi.stubGlobal('WebSocket', TestSocket);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('an open client reconnects through a service restart and signals history/sidebar resynchronization', () => {
  const { result, unmount } = renderHook(() => useWebSocket(), { wrapper });
  const events: ServerEvent[] = [];
  result.current.subscribe(event => events.push(event));
  const first = TestSocket.sockets[0];
  expect(first.url).toMatch(/\/workspace\/node\/ws$/);
  act(() => first.open());
  expect(result.current.isConnected).toBe(true);
  expect(events).toEqual([]);

  act(() => first.close());
  expect(result.current.isConnected).toBe(false);
  act(() => vi.advanceTimersByTime(2999));
  expect(TestSocket.sockets).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1));
  // The service is not ready on the first retry; no page reload or app exit is needed.
  act(() => TestSocket.sockets[1].close());
  act(() => vi.advanceTimersByTime(3000));
  act(() => TestSocket.sockets[2].open());
  expect(result.current.isConnected).toBe(true);
  expect(events.map(event => event.kind)).toEqual(['websocket_reconnected']);
  expect(TestSocket.sockets[2].sent).toEqual([]);
  unmount();
});

test('reconnection does not replay commands whose delivery or execution may already have happened', () => {
  const { result, unmount } = renderHook(() => useWebSocket(), { wrapper });
  const first = TestSocket.sockets[0];
  act(() => first.open());
  result.current.sendMessage({ type: 'chat', content: 'perform a side effect' });
  expect(first.sent).toHaveLength(1);
  act(() => first.close());
  result.current.sendMessage({ type: 'chat', content: 'not delivered while disconnected' });
  act(() => vi.advanceTimersByTime(3000));
  const next = TestSocket.sockets[1];
  act(() => next.open());
  expect(next.sent).toEqual([]);
  result.current.sendMessage({ type: 'chat', content: 'explicit new user request' });
  expect(next.sent).toHaveLength(1);
  unmount();
});

test('closing the view cancels pending retries instead of leaving a reconnect loop behind', () => {
  const { unmount } = renderHook(() => useWebSocket(), { wrapper });
  act(() => TestSocket.sockets[0].open());
  act(() => TestSocket.sockets[0].close());
  unmount();
  act(() => vi.advanceTimersByTime(60000));
  expect(TestSocket.sockets).toHaveLength(1);
});

test('returning from the background replaces a silently dead OPEN socket without waiting for close', () => {
  const { result, unmount } = renderHook(() => useWebSocket(), { wrapper });
  const events: ServerEvent[] = [];
  result.current.subscribe(event => events.push(event));
  const first = TestSocket.sockets[0];
  act(() => first.open());
  result.current.sendMessage({ type: 'chat.send', content: 'do not send twice' });

  act(() => visibility('hidden'));
  // Suspension lost the transport, but the browser has not delivered onclose.
  expect(first.readyState).toBe(TestSocket.OPEN);
  act(() => visibility('visible'));
  expect(TestSocket.sockets).toHaveLength(2);
  expect(first.readyState).toBe(TestSocket.CLOSED);
  expect(result.current.isConnected).toBe(false);
  act(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  expect(TestSocket.sockets).toHaveLength(2);

  act(() => TestSocket.sockets[1].open());
  expect(result.current.ws).toBe(TestSocket.sockets[1]);
  expect(events.map(event => event.kind)).toEqual(['websocket_reconnected']);
  expect(first.sent).toHaveLength(1);
  expect(TestSocket.sockets[1].sent).toEqual([]);
  unmount();
});

test('foreground recovery cancels an old retry timer and ignores late callbacks from the replaced socket', () => {
  const { result, unmount } = renderHook(() => useWebSocket(), { wrapper });
  const events: ServerEvent[] = [];
  result.current.subscribe(event => events.push(event));
  const first = TestSocket.sockets[0];
  act(() => first.open());
  const staleOpen = first.onopen;
  const staleMessage = first.onmessage;
  act(() => {
    visibility('hidden');
    first.close();
    visibility('visible');
  });
  expect(TestSocket.sockets).toHaveLength(2);
  act(() => {
    staleOpen?.();
    staleMessage?.({ data: JSON.stringify({ kind: 'complete', sessionId: 'stale' }) });
    vi.advanceTimersByTime(3000);
  });
  expect(result.current.isConnected).toBe(false);
  expect(events).toEqual([]);
  expect(TestSocket.sockets).toHaveLength(2);
  unmount();
});

test.each(['visibility', 'focus'])('a suspended handshake is replaced on foreground %s', (signal) => {
  const { unmount } = renderHook(() => useWebSocket(), { wrapper });
  act(() => visibility('hidden'));
  act(() => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    (signal === 'focus' ? window : document).dispatchEvent(new Event(signal === 'focus' ? 'focus' : 'visibilitychange'));
  });
  expect(TestSocket.sockets).toHaveLength(2);
  expect(TestSocket.sockets[0].readyState).toBe(TestSocket.CLOSED);
  unmount();
});

test.each(['online', 'pageshow'])('%s repairs an OPEN socket even without a preceding visibility event', (signal) => {
  const { unmount } = renderHook(() => useWebSocket(), { wrapper });
  act(() => TestSocket.sockets[0].open());
  act(() => window.dispatchEvent(signal === 'pageshow'
    ? new PageTransitionEvent('pageshow', { persisted: true }) : new Event(signal)));
  expect(TestSocket.sockets).toHaveLength(2);
  unmount();
});

test('ordinary focus/pageshow do not interrupt a healthy foreground socket and lifecycle listeners are removed on unmount', () => {
  const { unmount } = renderHook(() => useWebSocket(), { wrapper });
  act(() => TestSocket.sockets[0].open());
  act(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(TestSocket.sockets).toHaveLength(1);
  unmount();
  act(() => {
    visibility('hidden');
    visibility('visible');
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    vi.advanceTimersByTime(60000);
  });
  expect(TestSocket.sockets).toHaveLength(1);
});

test('a new socket identity reaches consumers even when disconnect/open updates are batched', () => {
  const { result, unmount } = renderHook(() => useWebSocket(), { wrapper });
  act(() => TestSocket.sockets[0].open());
  act(() => {
    visibility('hidden');
    visibility('visible');
    TestSocket.sockets[1]?.open();
  });
  expect(TestSocket.sockets).toHaveLength(2);
  expect(result.current.ws).toBe(TestSocket.sockets[1]);
  expect(result.current.isConnected).toBe(true);
  unmount();
});

test('an unresponsive handshake has a bounded retry instead of remaining CONNECTING forever', () => {
  const { unmount } = renderHook(() => useWebSocket(), { wrapper });
  act(() => vi.advanceTimersByTime(10000));
  expect(TestSocket.sockets[0].readyState).toBe(TestSocket.CLOSED);
  act(() => vi.advanceTimersByTime(3000));
  expect(TestSocket.sockets).toHaveLength(2);
  unmount();
});

test.each([false, true])('token refresh retires the previous socket and its callbacks (already open: %s)', (opened) => {
  const { result, rerender, unmount } = renderHook(() => useWebSocket(), { wrapper });
  const first = TestSocket.sockets[0];
  if (opened) act(() => first.open());
  const staleOpen = first.onopen;
  const staleClose = first.onclose;
  act(() => {
    auth.token = 'refreshed-token';
    rerender();
  });
  expect(TestSocket.sockets).toHaveLength(2);
  expect(first.readyState).toBe(TestSocket.CLOSED);
  act(() => {
    staleOpen?.();
    staleClose?.();
    TestSocket.sockets[1].open();
    vi.advanceTimersByTime(13000);
  });
  expect(TestSocket.sockets).toHaveLength(2);
  expect(result.current.ws).toBe(TestSocket.sockets[1]);
  unmount();
});

test('authentication gates initial and foreground connections and logout cancels recovery', () => {
  auth.isLoading = true;
  const { result, rerender, unmount } = renderHook(() => useWebSocket(), { wrapper });
  act(() => {
    visibility('hidden');
    visibility('visible');
    window.dispatchEvent(new Event('online'));
  });
  expect(TestSocket.sockets).toHaveLength(0);
  act(() => {
    auth.isLoading = false;
    rerender();
  });
  act(() => TestSocket.sockets[0].open());
  expect(result.current.isConnected).toBe(true);
  act(() => {
    auth.user = null;
    rerender();
  });
  expect(result.current.isConnected).toBe(false);
  expect(result.current.ws).toBeNull();
  act(() => {
    visibility('hidden');
    visibility('visible');
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(60000);
  });
  expect(TestSocket.sockets).toHaveLength(1);
  unmount();
});
