import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
import type { BackgroundSendChoice, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * #1587: follow-ups submitted while a turn runs used to replace each other in
 * the session's single queued slot, so only the last one reached the
 * provider. Every follow-up is now its own entry at the end of the session's
 * FIFO queue, shown as its own card, and the server sends them one turn each.
 *
 * The server is faked at the HTTP boundary with the drafts contract the real
 * server implements (`PUT /api/user/drafts/queue` applies append/remove
 * operations), so these tests see what the dispatcher would send, not only
 * what the cards render.
 */

type StoredQueued = { id?: string; content: string; options?: Record<string, unknown>; attachments?: unknown[] };
type StoredDraft = { text: string; queue: StoredQueued[] };
type QueueOperation = { kind: 'append' | 'remove'; message: StoredQueued };

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION_1: ProjectSession = { id: 'session-1' };
const SESSION_2: ProjectSession = { id: 'session-2' };

let server: Map<string, StoredDraft>;
// Held open by a test to keep an upload in flight (e.g. across a session switch).
let uploadGate: Promise<void> | null = null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const sameEntry = (left: StoredQueued, right: StoredQueued) =>
  (left.id ?? null) === (right.id ?? null) && left.content === right.content;

const store = (scope: string, draft: StoredDraft) => {
  if (!draft.text && draft.queue.length === 0) server.delete(scope);
  else server.set(scope, draft);
};

// The drafts endpoints, as the server implements them.
const fakeServer = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(url);
  const method = init?.method ?? 'GET';
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  const scope = String(body.scope ?? '');

  if (path.includes('/api/assets/files')) {
    await uploadGate;
    const form = init?.body instanceof FormData ? init.body : new FormData();
    const files = form.getAll('files') as File[];
    return json({ attachments: files.map((file) => ({ name: file.name, path: `/uploads/${file.name}` })) });
  }

  if (path.endsWith('/api/user/drafts/queue') && method === 'PUT') {
    let queue = [...(server.get(scope)?.queue ?? [])];
    for (const operation of body.queueOperations as QueueOperation[]) {
      if (operation.kind === 'append') {
        if (!queue.some((entry) => entry.id === operation.message.id)) queue.push(operation.message);
      } else {
        queue = queue.filter((entry) => !sameEntry(entry, operation.message));
      }
    }
    store(scope, { text: typeof body.text === 'string' ? body.text : '', queue });
    return json({ success: true });
  }

  if (path.endsWith('/api/user/drafts')) {
    if (method === 'GET') {
      return json({
        success: true,
        drafts: [...server].map(([draftScope, draft]) => ({
          scope: draftScope,
          text: draft.text,
          queuedMessage: draft.queue.length > 1 ? draft.queue : draft.queue[0] ?? null,
        })),
      });
    }
    if (method === 'PUT') {
      const current = server.get(scope) ?? { text: '', queue: [] };
      const text = typeof body.text === 'string' ? body.text : '';
      // A text-only autosave leaves the stored queue alone.
      const textOnly = body.preserveQueuedMessage === true || body.queuedMessage === undefined;
      const queued = body.queuedMessage as StoredQueued | StoredQueued[] | null;
      store(scope, {
        text,
        queue: textOnly ? current.queue : Array.isArray(queued) ? queued : queued ? [queued] : [],
      });
      return json({ success: true });
    }
    if (method === 'DELETE') {
      server.delete(scope);
      return json({ success: true });
    }
  }

  return json([]);
};

// What the server's dispatcher does when the session goes idle: take the
// first queued message off the queue to send it.
const dispatcherClaims = (scope: string): StoredQueued | null => {
  const draft = server.get(scope);
  const [claimed = null, ...rest] = draft?.queue ?? [];
  if (draft) store(scope, { ...draft, queue: rest });
  return claimed;
};

type Props = {
  session: ProjectSession;
  isLoading: boolean;
  model: string;
  processingSessions?: SessionActivityMap;
};

const render = (initialProps: Partial<Props> = {}) => renderHook(
  ({ session, isLoading, model, processingSessions }: Props) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session.id ?? null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: model,
    currentProviderEffort: 'medium',
    isLoading,
    processingSessions,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
  { initialProps: { session: SESSION_1, isLoading: true, model: 'model-1', ...initialProps } },
);

type View = ReturnType<typeof render>;

const submit = async (view: View, text: string, files: File[] = []) => {
  await act(async () => {
    view.result.current.setInput(text);
    view.result.current.setAttachedFiles(files);
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

const queuedOnServer = (scope = 'session-1') => server.get(scope)?.queue ?? [];
const contents = (messages: Array<{ content: string }>) => messages.map((message) => message.content);
// Queue writes leave the page at once, but their responses settle a tick later.
const serverQueueIs = (expected: string[], scope = 'session-1') =>
  waitFor(() => assert.deepEqual(contents(queuedOnServer(scope)), expected));

beforeEach(() => {
  server = new Map();
  uploadGate = null;
  resetChatDrafts();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(fakeServer));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatDrafts();
  localStorage.clear();
});

test('follow-ups A, B and C queued during one turn are all kept, in order, one card each', async () => {
  const view = render();

  await submit(view, 'follow-up A');
  await submit(view, 'follow-up B', [new File(['b'], 'b.txt', { type: 'text/plain' })]);
  view.rerender({ session: SESSION_1, isLoading: true, model: 'model-2' });
  await submit(view, 'follow-up C');

  await serverQueueIs(['follow-up A', 'follow-up B', 'follow-up C']);
  const [a, b, c] = queuedOnServer();
  assert.deepEqual(a.attachments, []);
  assert.deepEqual(b.attachments, [{ name: 'b.txt', path: '/uploads/b.txt' }], 'each message keeps its own files');
  assert.equal(a.options?.model, 'model-1', 'and the send options it was composed under');
  assert.equal(c.options?.model, 'model-2');
  assert.deepEqual(contents(view.result.current.queuedDrafts), ['follow-up A', 'follow-up B', 'follow-up C']);
  assert.equal(view.result.current.input, '');
});

test('a follow-up queued after the server sent the waiting one is queued alone, so nothing is sent twice', async () => {
  const view = render();
  await submit(view, 'follow-up A');
  await serverQueueIs(['follow-up A']);

  // The turn ended and the dispatcher took A, before this page heard about it.
  assert.equal(dispatcherClaims('session-1')?.content, 'follow-up A');

  await submit(view, 'follow-up B');

  await serverQueueIs(['follow-up B']);
});

test('typing after the server sent the queued message does not bring it back', async () => {
  const view = render();
  await submit(view, 'follow-up A');
  await serverQueueIs(['follow-up A']);
  dispatcherClaims('session-1');

  // The user keeps writing the next follow-up; the text save is debounced.
  await act(async () => { view.result.current.setInput('still writing the next one'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });

  assert.equal(server.get('session-1')?.text, 'still writing the next one', 'the text was saved');
  assert.deepEqual(queuedOnServer(), [], 'and A, already sent, is not queued again');
});

test('queueing behind background work adds a card after a message already waiting there', async () => {
  const background: SessionActivityMap = new Map([[
    'session-1',
    { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: [] },
  ]]);
  const view = render({ isLoading: false, processingSessions: background });

  const queueBehindWork = async (text: string) => {
    await act(async () => { view.result.current.setInput(text); });
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
    await act(async () => {
      view.result.current.resolveBackgroundSendPrompt('queue' as BackgroundSendChoice);
      await pending;
    });
  };

  await queueBehindWork('after the job: A');
  // A message is already waiting, so B joins the queue without asking again.
  await submit(view, 'after the job: B');

  await serverQueueIs(['after the job: A', 'after the job: B']);
  assert.deepEqual(contents(view.result.current.queuedDrafts), ['after the job: A', 'after the job: B']);
});

test('editing a card brings back that message with its files and takes only it off the queue', async () => {
  const fileA = new File(['a'], 'a.txt', { type: 'text/plain' });
  const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });
  const view = render();
  await submit(view, 'follow-up A', [fileA]);
  await submit(view, 'follow-up B', [fileB]);
  await serverQueueIs(['follow-up A', 'follow-up B']);

  const second = view.result.current.queuedDrafts[1];
  await act(async () => { view.result.current.editQueuedDraft(second.id); });

  assert.equal(view.result.current.input, 'follow-up B');
  assert.deepEqual(view.result.current.attachedFiles.map((file) => file.name), ['b.txt']);
  assert.deepEqual(contents(view.result.current.queuedDrafts), ['follow-up A']);
  await serverQueueIs(['follow-up A']);
});

test('deleting a card takes only that message off the queue', async () => {
  const view = render();
  await submit(view, 'follow-up A');
  await submit(view, 'follow-up B');
  await serverQueueIs(['follow-up A', 'follow-up B']);

  await act(async () => { view.result.current.deleteQueuedDraft(); });

  assert.deepEqual(contents(view.result.current.queuedDrafts), ['follow-up B']);
  await serverQueueIs(['follow-up B']);
});

test('a message queued from another tab is kept when this tab queues one behind it', async () => {
  // Another tab (or this page before a reload) queued a message; this page has not heard of it.
  server.set('session-1', { text: '', queue: [{ id: 'other-tab', content: 'from the other tab', attachments: [] }] });
  const view = render();

  await submit(view, 'from this tab');

  await serverQueueIs(['from the other tab', 'from this tab']);
});

test('switching sessions during the upload still queues the follow-up behind the earlier one', async () => {
  const view = render();
  await submit(view, 'follow-up A');

  let releaseUpload!: () => void;
  uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  await act(async () => {
    view.result.current.setInput('follow-up B');
    view.result.current.setAttachedFiles([new File(['b'], 'b.txt', { type: 'text/plain' })]);
  });
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  view.rerender({ session: SESSION_2, isLoading: true, model: 'model-1' });
  await act(async () => {
    releaseUpload();
    await pending;
  });

  await serverQueueIs(['follow-up A', 'follow-up B']);
  assert.deepEqual(view.result.current.queuedDrafts, [], 'the session now open has no card of its own');
  assert.equal(readDraftText('session-1'), '', 'and going back will not offer B to be queued again');
});
