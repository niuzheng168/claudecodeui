import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { generatedWorktreeBranch, useNewSessionWorktree } from '@/modules/chat/hooks/useNewSessionWorktree';
import type { ChatMessage, PermissionMode, Project, SessionEstablishedContext } from '@/shared/types';

/**
 * The new session page can start the session in a new worktree instead of the
 * open directory: the page asks the node whether the directory is in a git
 * repository, and the first send makes the worktree before it allocates the
 * session there.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'repo', fullPath: '/src/repo' };
const WORKTREE: Project = {
  projectId: 'project-2',
  displayName: 'feature-x',
  path: '/src/repo-worktrees/feature-x',
  fullPath: '/src/repo-worktrees/feature-x',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const LISTING = {
  success: true,
  data: {
    repositoryRoot: '/src/repo',
    baseBranch: 'main',
    worktrees: [
      { path: '/src/repo', branch: 'main', isMain: true, isCurrent: false },
      { path: '/src/repo-worktrees/topic', branch: 'topic', isMain: false, isCurrent: true },
    ],
  },
};

let listResponse: () => Response;
let createResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

const requests = (path: string) => fetchMock.mock.calls
  .filter(([url]) => String(url).split('?')[0] === path)
  .map(([url, init]) => ({ url: String(url), body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : null }));

beforeEach(() => {
  listResponse = () => jsonResponse(LISTING);
  createResponse = () => jsonResponse({ success: true, data: { worktreePath: WORKTREE.fullPath, branch: 'feature-x', createdBranch: true, project: WORKTREE } });
  fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    if (path === '/api/worktrees') return Promise.resolve(listResponse());
    if (path === '/api/worktrees/create' && init?.method === 'POST') return Promise.resolve(createResponse());
    if (path === '/api/providers/sessions' && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ success: true, data: { sessionId: 'session-1', sessionName: 'hello' } }, 201));
    }
    return Promise.resolve(jsonResponse([]));
  });
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderWorktree = (isNewSession = true) => renderHook(
  ({ project, fresh }: { project: Project; fresh: boolean }) => useNewSessionWorktree(project, fresh),
  { initialProps: { project: PROJECT, fresh: isNewSession } },
);

test('a directory in a git repository offers a worktree off the branch it has checked out', async () => {
  const { result } = renderWorktree();
  await waitFor(() => assert.equal(result.current.available, true));
  assert.equal(result.current.baseBranch, 'topic');
  assert.equal(result.current.enabled, false, 'off until the user turns it on');
  assert.deepEqual(requests('/api/worktrees').map((request) => request.url), ['/api/worktrees?project=project-1']);
});

test('no offer outside a repository, on a node without the route, or for an open session', async () => {
  listResponse = () => jsonResponse({ success: false, error: { code: 'NOT_A_GIT_REPOSITORY' } }, 400);
  const outside = renderWorktree();
  // A node without the route answers with its app page.
  listResponse = () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const old = renderWorktree();
  const open = renderWorktree(false);
  await waitFor(() => assert.equal(requests('/api/worktrees').length, 2));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(outside.result.current.available, false);
  assert.equal(old.result.current.available, false);
  assert.equal(open.result.current.available, false);
  assert.equal(await open.result.current.prepare(), null);
});

test('prepare makes the worktree with the typed branch, or a made-up one, once', async () => {
  const { result } = renderWorktree();
  await waitFor(() => assert.equal(result.current.available, true));
  assert.equal(await result.current.prepare(), null, 'nothing to make while the choice is off');

  act(() => { result.current.setEnabled(true); });
  let project: Project | null = null;
  await act(async () => { project = await result.current.prepare(); });
  assert.deepEqual(project, WORKTREE);
  const [made] = requests('/api/worktrees/create');
  assert.equal(made.body.project, 'project-1');
  assert.equal(made.body.baseBranch, 'topic');
  assert.match(made.body.branch, /^codey\/\d{6}-\d{6}$/);

  // The session failed to start: the next try uses the same worktree.
  await act(async () => { project = await result.current.prepare(); });
  assert.deepEqual(project, WORKTREE);
  assert.equal(requests('/api/worktrees/create').length, 1);

  act(() => { result.current.setBranch(' feature-x '); });
  await act(async () => { await result.current.prepare(); });
  assert.equal(requests('/api/worktrees/create')[1].body.branch, 'feature-x');
});

test('git refusing the worktree comes back as an error with its reason', async () => {
  createResponse = () => jsonResponse({ success: false, error: { message: 'Folder already exists', details: '/src/repo-worktrees/x' } }, 409);
  const { result } = renderWorktree();
  await waitFor(() => assert.equal(result.current.available, true));
  act(() => { result.current.setEnabled(true); });
  await assert.rejects(result.current.prepare(), /Folder already exists: \/src\/repo-worktrees\/x/);
  assert.equal(result.current.creating, false);
});

test('a new session page for another project starts with the choice off', async () => {
  const view = renderWorktree();
  await waitFor(() => assert.equal(view.result.current.available, true));
  act(() => { view.result.current.setEnabled(true); });
  view.rerender({ project: WORKTREE, fresh: true });
  await waitFor(() => assert.equal(requests('/api/worktrees').length, 2));
  await waitFor(() => assert.equal(view.result.current.available, true));
  assert.equal(view.result.current.enabled, false);
});

test('the generated branch name is codey/ plus the date and time', () => {
  assert.equal(generatedWorktreeBranch(new Date(2026, 9, 29, 7, 5, 9)), 'codey/261029-070509');
});

const renderComposer = (prepareNewSessionProject: () => Promise<Project | null>) => {
  const sent: Array<{ type: string; sessionId?: string; content?: string }> = [];
  const established: Array<{ sessionId: string; context: SessionEstablishedContext }> = [];
  const messages: ChatMessage[] = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: null,
    currentSessionId: null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message) => { sent.push(message as { type: string }); },
    onSessionEstablished: (sessionId, context) => { established.push({ sessionId, context }); },
    prepareNewSessionProject,
    scrollToBottom: () => undefined,
    addMessage: (message) => { messages.push(message); },
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  return { view, sent, established, messages };
};

const send = async (view: ReturnType<typeof renderComposer>['view'], text: string) => {
  await act(async () => { view.result.current.setInput(text); });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

test('the first send starts the session in the worktree and hands its project on', async () => {
  const { view, sent, established } = renderComposer(async () => WORKTREE);
  await send(view, 'hello');

  assert.deepEqual(requests('/api/providers/sessions').map((request) => request.body.projectPath), [WORKTREE.fullPath]);
  assert.deepEqual(established.map(({ sessionId, context }) => [sessionId, context.project.projectId]), [['session-1', 'project-2']]);
  assert.deepEqual(sent.filter((message) => message.type === 'chat.send').map((message) => message.sessionId), ['session-1']);
});

test('without a worktree the session starts in the open project, as before', async () => {
  const { view, established } = renderComposer(async () => null);
  await send(view, 'hello');

  assert.deepEqual(requests('/api/providers/sessions').map((request) => request.body.projectPath), [PROJECT.fullPath]);
  assert.equal(established[0]?.context.project, PROJECT);
});

test('a worktree that cannot be made stops the send and keeps the text', async () => {
  const { view, sent, established, messages } = renderComposer(async () => { throw new Error('Branch "x" is already checked out'); });
  await send(view, 'hello');

  assert.equal(requests('/api/providers/sessions').length, 0, 'no session is allocated');
  assert.equal(established.length, 0);
  assert.equal(sent.filter((message) => message.type === 'chat.send').length, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'error');
  assert.match(String(messages[0].content), /Branch "x" is already checked out/);
  assert.equal(view.result.current.input, 'hello');
});
