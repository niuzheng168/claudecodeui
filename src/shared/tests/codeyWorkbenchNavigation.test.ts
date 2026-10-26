import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import {
  onWorkbenchNewSession,
  onWorkbenchOpenSession,
  useWorkbenchPageReady,
  WORKBENCH_NEW_SESSION_MESSAGE,
  WORKBENCH_OPEN_SESSION_MESSAGE,
  type WorkbenchNewSession,
} from '@/shared/codeyWorkbench';

/**
 * The Codey Workbench switches an open frame to another session of its machine,
 * or to the new session page of one of its projects, instead of loading the app
 * again. In a test the page is its own parent.
 */

type Sender = { origin?: string; source?: MessageEventSource | null };

const post = (data: Record<string, unknown>, { origin = window.location.origin, source = window }: Sender = {}) => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
};

const ask = (data: Record<string, unknown>, sender?: Sender) => post({ type: WORKBENCH_OPEN_SESSION_MESSAGE, ...data }, sender);

const askNewSession = (data: Record<string, unknown>, sender?: Sender) => post({ type: WORKBENCH_NEW_SESSION_MESSAGE, ...data }, sender);

test('the page says it can switch sessions, and passes on each session the Workbench asks for', () => {
  // The mark is set only inside a frame; jsdom's page is its own parent.
  assert.equal(document.documentElement.hasAttribute('data-codey-workbench-navigation'), window.parent !== window);
  const opened: string[] = [];
  const stop = onWorkbenchOpenSession((sessionId) => opened.push(sessionId));
  ask({ sessionId: 'session-1' });
  ask({ sessionId: '' });
  ask({ sessionId: 42 });
  stop();
  ask({ sessionId: 'after-unsubscribe' });
  assert.deepEqual(opened, ['session-1']);
});

test('inside a frame, the page is marked ready while a drawn workspace is mounted', () => {
  const parent = Object.getOwnPropertyDescriptor(window, 'parent');
  Object.defineProperty(window, 'parent', { value: {}, configurable: true });
  try {
    const ready = () => document.documentElement.hasAttribute('data-codey-workbench-ready');
    assert.equal(ready(), false);
    const first = renderHook(() => useWorkbenchPageReady());
    const second = renderHook(() => useWorkbenchPageReady());
    assert.equal(ready(), true);
    first.unmount();
    assert.equal(ready(), true, 'another workspace view is still drawn');
    second.unmount();
    assert.equal(ready(), false);
  } finally {
    if (parent) Object.defineProperty(window, 'parent', parent);
  }
});

test('only the embedding page on this origin can switch the session', () => {
  const opened: string[] = [];
  const stop = onWorkbenchOpenSession((sessionId) => opened.push(sessionId));
  ask({ sessionId: 'foreign-origin' }, { origin: 'https://example.invalid' });
  ask({ sessionId: 'other-window' }, { source: null });
  stop();
  assert.deepEqual(opened, []);
});

test('the page says it can open new session pages, and passes on each project the Workbench asks for', () => {
  assert.equal(document.documentElement.hasAttribute('data-codey-workbench-new-session'), window.parent !== window);
  const requested: WorkbenchNewSession[] = [];
  const stop = onWorkbenchNewSession((request) => requested.push(request));
  askNewSession({ projectId: 'project-1', path: '/repo/one', name: 'one' });
  askNewSession({ projectId: 'project-2' });
  askNewSession({ projectId: '' });
  askNewSession({ projectId: 7, path: '/repo/seven' });
  askNewSession({ projectId: 'foreign-origin' }, { origin: 'https://example.invalid' });
  askNewSession({ projectId: 'other-window' }, { source: null });
  stop();
  askNewSession({ projectId: 'after-unsubscribe' });
  assert.deepEqual(requested, [
    { projectId: 'project-1', path: '/repo/one', name: 'one' },
    { projectId: 'project-2', path: '', name: '' },
  ]);
});
