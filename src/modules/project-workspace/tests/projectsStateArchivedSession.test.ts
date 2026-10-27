import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * A session archived without this client, as when Claude Desktop's archive
 * reaches Codey, arrives as `session_archived`: the sidebar drops its row.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const renderProjectsState = async (navigate: ReturnType<typeof vi.fn>, urlSessionId?: string) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(() =>
    useProjectsState({
      sessionId: urlSessionId,
      navigate: navigate as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('a session archived elsewhere leaves the sidebar, and a chat open on it stays open', async () => {
  const project: Project = {
    projectId: 'project-1',
    path: '/repo',
    fullPath: '/repo',
    displayName: 'Repo',
    isStarred: false,
    sessions: [{ id: 'kept', summary: 'Kept' }, { id: 'archived', summary: 'Archived in Desktop' }] as ProjectSession[],
    sessionMeta: { hasMore: false, total: 2 },
  };
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [project] });
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate, 'archived');

  await waitFor(() => {
    assert.equal(result.current.projects[0]?.sessions?.length, 2);
  });
  act(() => {
    result.current.handleSessionSelect({ id: 'archived' } as ProjectSession);
  });
  navigate.mockClear();

  await act(async () => {
    emit({ kind: 'session_archived', sessionId: 'archived', timestamp: '2026-10-27T10:00:00.000Z' });
  });

  assert.deepEqual((result.current.projects[0]?.sessions ?? []).map((session) => session.id), ['kept']);
  assert.equal(result.current.projects[0]?.sessionMeta?.total, 1);
  assert.equal(result.current.selectedSession?.id, 'archived');
  assert.deepEqual(navigate.mock.calls, []);
});
