import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { onWorkbenchOpenSession, useWorkbenchPageReady, WORKBENCH_OPEN_SESSION_MESSAGE } from '@/shared/codeyWorkbench';

/**
 * The Codey Workbench switches an open frame to another session of its machine
 * instead of loading the app again. In a test the page is its own parent.
 */

const ask = (data: Record<string, unknown>, { origin = window.location.origin, source = window as MessageEventSource | null } = {}) => {
  window.dispatchEvent(new MessageEvent('message', { data: { type: WORKBENCH_OPEN_SESSION_MESSAGE, ...data }, origin, source }));
};

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
