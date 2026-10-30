import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * A new session page can start its session in a new worktree, a project the
 * page was not showing. The session's project must be selected in the same
 * render as the session: in between, the chat would load the session under
 * the old project and then again under the new one, and subscribe to its run
 * twice.
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

const REPO: Project = {
  projectId: 'project-1',
  path: '/src/repo',
  fullPath: '/src/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
};

const WORKTREE: Project = {
  projectId: 'project-2',
  path: '/src/repo-worktrees/feature-x',
  fullPath: '/src/repo-worktrees/feature-x',
  displayName: 'feature-x',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
};

const renderProjectsState = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const renders: Array<[string | undefined, string | undefined]> = [];
  const view = renderHook(() => {
    const state = useProjectsState({
      sessionId: undefined,
      navigate: vi.fn() as never,
      subscribe: () => () => undefined,
      isMobile: false,
      isSessionProcessing: () => false,
    });
    renders.push([state.selectedSession?.id, state.selectedProject?.projectId]);
    return state;
  });
  return { ...view, renders };
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [REPO] });
});

afterEach(() => {
  vi.resetModules();
});

test('a session started in a new worktree selects the worktree project with it', async () => {
  const { result, renders } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, REPO.projectId));

  renders.length = 0;
  act(() => {
    result.current.registerOptimisticSession({ sessionId: 'session-1', provider: 'claude', project: WORKTREE, summary: 'hello' });
  });

  assert.equal(result.current.selectedSession?.id, 'session-1');
  assert.equal(result.current.selectedProject?.projectId, WORKTREE.projectId);
  assert.equal(result.current.selectedProject?.fullPath, WORKTREE.fullPath);
  assert.deepEqual(
    renders.filter(([sessionId]) => sessionId === 'session-1').map(([, projectId]) => projectId),
    renders.filter(([sessionId]) => sessionId === 'session-1').map(() => WORKTREE.projectId),
    'no render shows the new session under the old project',
  );
  assert.deepEqual(
    result.current.projects.map((project: Project) => [project.projectId, (project.sessions ?? []).map((session: ProjectSession) => session.id)]),
    [['project-2', ['session-1']], ['project-1', []]],
  );
});

test('a session started in the open project leaves the selection alone', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, REPO.projectId));
  const selected = result.current.selectedProject;

  act(() => {
    result.current.registerOptimisticSession({ sessionId: 'session-1', provider: 'claude', project: REPO, summary: 'hello' });
  });

  assert.equal(result.current.selectedSession?.id, 'session-1');
  assert.equal(result.current.selectedProject, selected);
});
