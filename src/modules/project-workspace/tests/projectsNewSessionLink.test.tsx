import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { WORKBENCH_NEW_SESSION_MESSAGE } from '@/shared/codeyWorkbench';
import type { Project } from '@/shared/types';

/**
 * `/?project=<projectId>` is how the Codey Workbench starts a new session in a
 * project while this app's sidebar is hidden: the page must land on the new
 * session view of that project, exactly as the sidebar's "New Session" does.
 * A page the Workbench already has open is asked by message instead.
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

const buildProject = (projectId: string, fullPath: string): Project => ({
  projectId,
  path: fullPath,
  fullPath,
  displayName: fullPath.split('/').pop() ?? fullPath,
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
});

const renderProjectsState = async (navigate: ReturnType<typeof vi.fn>, sessionId?: string) => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId,
      navigate,
      subscribe: () => () => undefined,
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

const askNewSession = (data: Record<string, unknown>) => {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: WORKBENCH_NEW_SESSION_MESSAGE, ...data },
    origin: window.location.origin,
    source: window,
  }));
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject('project-1', '/repo/one'), buildProject('project-2', '/repo/two')],
  });
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.resetModules();
});

test('a project link opens the new session view of that project', async () => {
  window.history.replaceState({}, '', '/?project=project-2');
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);

  await waitFor(() => assert.equal(result.current.selectedProject?.projectId, 'project-2'));
  assert.equal(result.current.selectedSession, null);
  assert.equal(result.current.activeTab, 'chat');
  assert.deepEqual(navigate.mock.calls, [['/']]);
});

test('an unknown project link only drops the parameter', async () => {
  window.history.replaceState({}, '', '/?project=missing');
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);

  await waitFor(() => assert.deepEqual(navigate.mock.calls, [['/', { replace: true }]]));
  assert.equal(result.current.selectedProject, null);
});

test('a session in the address wins over a project link', async () => {
  window.history.replaceState({}, '', '/session/s-1?project=project-2');
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate, 's-1');

  await waitFor(() => assert.equal(result.current.isLoadingProjects, false));
  assert.notEqual(result.current.selectedProject?.projectId, 'project-2');
  assert.equal(navigate.mock.calls.some(([path]) => path === '/'), false);
});

test('the Workbench opens the new session view of a project in a page it already has open', async () => {
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);
  await waitFor(() => assert.equal(result.current.isLoadingProjects, false));
  const trigger = result.current.newSessionTrigger;

  act(() => askNewSession({ projectId: 'project-2', path: '/repo/two', name: 'two' }));

  assert.equal(result.current.selectedProject?.projectId, 'project-2');
  assert.equal(result.current.selectedSession, null);
  assert.equal(result.current.activeTab, 'chat');
  assert.equal(result.current.newSessionTrigger, trigger + 1);
  assert.deepEqual(navigate.mock.calls, [['/']]);
  assert.equal(projectsResponse.mock.calls.length, 1, 'a listed project needs no new list');
});

test('a project the page has not listed yet opens as the Workbench describes it, and the list is read again', async () => {
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);
  await waitFor(() => assert.equal(result.current.isLoadingProjects, false));

  act(() => askNewSession({ projectId: 'project-3', path: '/repo/three', name: 'three' }));

  assert.equal(result.current.selectedProject?.projectId, 'project-3');
  assert.equal(result.current.selectedProject?.fullPath, '/repo/three');
  assert.equal(result.current.selectedProject?.displayName, 'three');
  assert.deepEqual(navigate.mock.calls, [['/']]);
  await waitFor(() => assert.equal(projectsResponse.mock.calls.length, 2));
});
