import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import type { NormalizedMessage, PendingPermissionRequest, Project, ProjectSession, ServerEvent } from '@/shared/types';
import type * as SharedUtils from '@/shared/utils';

const historyRequest = vi.fn();
const auth = vi.hoisted(() => ({ isLoading: false, token: null, user: { id: 'owner' } }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/utils', async (importOriginal) => ({
  ...await importOriginal<typeof SharedUtils>(),
  IS_PLATFORM: true,
  playChatCompletionSound: vi.fn(),
  playNotificationSound: vi.fn(),
}));
vi.mock('@/shared/api', () => ({
  api: { providers: {
    sessionMessages: (...args: unknown[]) => historyRequest(...args),
    sessionTokenUsage: async () => ({ ok: true, json: async () => ({ data: null }) }),
  } },
}));

// The real transport provider and chat hooks run together; only the wire and
// REST responses are faked, including a socket that stays OPEN while offline.
class ResumeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static sockets: ResumeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor() { ResumeSocket.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(event: ServerEvent) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const noop = () => {};
const project = { projectId: 'project', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false } as Project;
const selectedSession = { id: 'session', __provider: 'codex' } as ProjectSession;
const permissions: PendingPermissionRequest[] = [];
const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(WebSocketProvider, null, children);
const message = (id: string, content: string, role: 'user' | 'assistant' = 'assistant'): NormalizedMessage => ({
  id, sessionId: 'session', provider: 'codex', kind: 'text', role, content,
  timestamp: role === 'user' ? '2026-09-30T10:00:00Z' : '2026-09-30T10:00:01Z',
});
const question = message('question', 'Explain this', 'user');
const reply = message('reply', 'Finished while the phone was away');
const history = (messages: NormalizedMessage[]) => ({
  ok: true, json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

function visibility(state: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

async function setup() {
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };
  const streamTimerRef = { current: null as number | null };
  const accumulatedStreamRef = { current: '' };
  const view = renderHook(({ isActive, session }) => {
    const socket = useWebSocket();
    const store = useSessionStore();
    const activity = useSessionProtection();
    const state = useChatSessionState({
      isActive, selectedProject: project, selectedSession: session,
      ws: socket.ws, sendMessage: socket.sendMessage, resetStreamingState: noop,
      statusCheckSentAtRef, lastSeqRef, sessionStore: store,
      processingSessions: activity.processingSessions, onSessionIdle: activity.markSessionIdle,
    });
    useChatRealtimeHandlers({
      isActive, subscribe: socket.subscribe, provider: 'codex', selectedSession: session,
      currentSessionId: state.currentSessionId, setTokenBudget: state.setTokenBudget,
      pendingPermissionRequests: permissions, setPendingPermissionRequests: noop,
      streamTimerRef, accumulatedStreamRef, lastSeqRef, statusCheckSentAtRef,
      onSessionProcessing: activity.markSessionProcessing, onSessionIdle: activity.markSessionIdle,
      requestLatestMessages: state.requestLatestMessages, sessionStore: store,
    });
    return { state, socket, store };
  }, { wrapper, initialProps: { isActive: true, session: selectedSession } });
  await act(async () => ResumeSocket.sockets[0].open());
  expect(view.result.current.state.chatMessages).toHaveLength(1);
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', ResumeSocket);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', noop);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  ResumeSocket.sockets = [];
  historyRequest.mockReset().mockResolvedValue(history([question]));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('foreground recovery fetches a completed reply even when the old view still says processing', async () => {
  const { result, unmount } = await setup();
  const first = ResumeSocket.sockets[0];
  act(() => first.receive({ kind: 'chat_subscribed', sessionId: 'session', isProcessing: true }));
  expect(result.current.state.isProcessing).toBe(true);
  act(() => visibility('hidden'));
  historyRequest.mockResolvedValue(history([question, reply]));
  act(() => vi.advanceTimersByTime(60000));
  await act(async () => visibility('visible'));
  expect(ResumeSocket.sockets).toHaveLength(2);
  // Completed output is visible even before the replacement socket opens.
  expect(result.current.store.getMessages('session').at(-1)?.content).toBe(reply.content);
  expect(historyRequest).toHaveBeenCalledTimes(2);
  const resumed = ResumeSocket.sockets[1];
  await act(async () => resumed.open());
  act(() => resumed.receive({ kind: 'chat_subscribed', sessionId: 'session', isProcessing: false }));
  expect(result.current.state.isProcessing).toBe(false);
  expect(result.current.store.getMessages('session').map(row => row.content)).toEqual([question.content, reply.content]);
  expect(historyRequest).toHaveBeenCalledTimes(3);
  expect(historyRequest.mock.calls[1][1]).toEqual({ limit: 20, offset: 0 });
  expect(resumed.sent).toEqual([{ type: 'chat.subscribe', sessions: [{ sessionId: 'session', lastSeq: 0 }] }]);
  unmount();
});

test('background completion defers REST until foreground and lifecycle bursts do not duplicate that read', async () => {
  const { result, unmount } = await setup();
  const first = ResumeSocket.sockets[0];
  act(() => visibility('hidden'));
  historyRequest.mockResolvedValue(history([question, reply]));
  await act(async () => first.receive({
    kind: 'complete', sessionId: 'session', success: false,
  }));
  expect(historyRequest).toHaveBeenCalledTimes(1);
  await act(async () => {
    visibility('visible');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(historyRequest).toHaveBeenCalledTimes(2);
  expect(result.current.store.getMessages('session').at(-1)?.content).toBe(reply.content);
  unmount();
});

test('live replay and status resume before a slow history read, with no delayed second subscription', async () => {
  const { result, rerender, unmount } = await setup();
  act(() => ResumeSocket.sockets[0].receive({
    kind: 'stream_delta', sessionId: 'session', seq: 7, content: 'Before ',
  }));
  act(() => vi.advanceTimersByTime(100));
  act(() => visibility('hidden'));
  let finish!: (response: ReturnType<typeof history>) => void;
  historyRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => visibility('visible'));
  const resumed = ResumeSocket.sockets[1];
  await act(async () => resumed.open());
  expect(historyRequest).toHaveBeenCalledTimes(2);
  expect(resumed.sent).toEqual([{ type: 'chat.subscribe', sessions: [{ sessionId: 'session', lastSeq: 7 }] }]);
  act(() => {
    resumed.receive({ kind: 'chat_subscribed', sessionId: 'session', isProcessing: true, canInterrupt: true });
    resumed.receive({ kind: 'stream_delta', sessionId: 'session', seq: 8, content: 'after' });
    vi.advanceTimersByTime(100);
  });
  expect(result.current.state.isProcessing).toBe(true);
  expect(result.current.store.getMessages('session').some(row => row.content === 'Before after')).toBe(true);

  // Sidebar reloads replace objects; they must not replay the same stream.
  act(() => rerender({ isActive: true, session: { ...selectedSession } }));
  await act(async () => finish(history([question])));
  expect(resumed.sent).toHaveLength(1);
  expect(result.current.store.getMessages('session').some(row => row.content === 'Before after')).toBe(true);
  unmount();
});

test('a reconnect while another main tab is selected restores live status but defers history until Chat opens', async () => {
  const { result, rerender, unmount } = await setup();
  act(() => rerender({ isActive: false, session: selectedSession }));
  act(() => {
    visibility('hidden');
    visibility('visible');
  });
  const resumed = ResumeSocket.sockets[1];
  await act(async () => resumed.open());
  expect(resumed.sent).toHaveLength(1);
  expect(historyRequest).toHaveBeenCalledTimes(1);
  historyRequest.mockResolvedValue(history([question, reply]));
  await act(async () => rerender({ isActive: true, session: selectedSession }));
  expect(historyRequest).toHaveBeenCalledTimes(2);
  expect(result.current.store.getMessages('session').at(-1)?.content).toBe(reply.content);
  expect(resumed.sent).toHaveLength(1);
  unmount();
});

test('finishing an old reconnect history read cannot re-subscribe to a session the user has left', async () => {
  const { rerender, unmount } = await setup();
  let finish!: (response: ReturnType<typeof history>) => void;
  historyRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => {
    visibility('hidden');
    visibility('visible');
  });
  const resumed = ResumeSocket.sockets[1];
  await act(async () => resumed.open());
  await act(async () => rerender({ isActive: true, session: { ...selectedSession, id: 'other' } }));
  expect(resumed.sent).toHaveLength(2);
  await act(async () => finish(history([question, reply])));
  expect(resumed.sent).toHaveLength(2);
  expect(resumed.sent.at(-1)).toEqual({
    type: 'chat.subscribe', sessions: [{ sessionId: 'other', lastSeq: 0 }],
  });
  unmount();
});
