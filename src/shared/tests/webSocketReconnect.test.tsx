import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

const auth = vi.hoisted(() => ({ isLoading: false, token: null, user: { id: 'owner' } }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/utils', () => ({
  IS_PLATFORM: true,
  isCodeyPortalSso: () => true,
  deploymentStorageKey: (value: string) => 'reconnect-test-' + value,
  returnToCodeyLogin: vi.fn(),
  withDeploymentBasePath: (value: string) => '/workspace/node' + value,
}));

class TestSocket {
  static OPEN = 1;
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

beforeEach(() => {
  vi.useFakeTimers();
  TestSocket.sockets = [];
  vi.stubGlobal('WebSocket', TestSocket);
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
