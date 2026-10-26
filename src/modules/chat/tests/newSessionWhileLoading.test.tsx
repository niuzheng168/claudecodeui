import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Leaving a session while its messages are still loading — for a new session,
 * as the Codey Workbench now opens one inside the open page, or otherwise —
 * drops that load's result. The page left behind must not keep saying it is
 * loading messages.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};
const session: ProjectSession = { id: 'session-a', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 3 } as ProjectSession;

let finishLoading: (slot: unknown) => void = () => undefined;
const store = {
  fetchFromServer: vi.fn(() => new Promise((resolve) => { finishLoading = resolve; })),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn(() => undefined),
};

async function renderLoadingSession() {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const hook = renderHook(
    ({ selectedSession, newSessionTrigger }: { selectedSession: ProjectSession | null; newSessionTrigger: number }) =>
      useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession,
        newSessionTrigger,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState: vi.fn(),
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: store as never,
        processingSessions: new Map(),
      }),
    { initialProps: { selectedSession: session as ProjectSession | null, newSessionTrigger: 0 } },
  );
  await act(async () => {});
  assert.equal(hook.result.current.isLoadingSessionMessages, true);
  return hook;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('a new session started while the last one loads is not left loading', async () => {
  const hook = await renderLoadingSession();

  await act(async () => {
    hook.rerender({ selectedSession: null, newSessionTrigger: 1 });
  });
  assert.equal(hook.result.current.isLoadingSessionMessages, false);

  await act(async () => {
    finishLoading({ fetchedAt: 1, status: 'idle', total: 3, hasMore: false, offset: 0 });
  });
  assert.equal(hook.result.current.isLoadingSessionMessages, false);
  assert.equal(hook.result.current.currentSessionId, null);
});

test('leaving a loading session without a new session ends the loading too', async () => {
  const hook = await renderLoadingSession();

  await act(async () => {
    hook.rerender({ selectedSession: null, newSessionTrigger: 0 });
  });
  assert.equal(hook.result.current.isLoadingSessionMessages, false);
});
