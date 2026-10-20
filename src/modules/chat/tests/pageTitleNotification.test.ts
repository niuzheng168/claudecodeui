import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { getPageTitle } from '@/shared/utils';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  Object.defineProperty(window, '__CLOUDCLI_BASE_PATH__', { value: '/cloudcli/linux-gpu/', configurable: true });
});

const returnToWorkspace = (): void => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  window.dispatchEvent(new Event('focus'));
};

afterEach(() => {
  // Exercise the normal cleanup path so no module-owned listeners survive a test.
  returnToWorkspace();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__CLOUDCLI_BASE_PATH__');
  Reflect.deleteProperty(window, '__CLOUDCLI_NODE__');
  document.title = '';
});

test('background completion preserves the node prefix and selected session context', () => {
  document.title = getPageTitle(null, {
    id: 'session-1', summary: 'Fix the settings page', __provider: 'codex',
  });
  showCompletionTitleIndicator();
  expect(document.title).toBe('linux-gpu [Done] · Fix the settings page');
  vi.advanceTimersByTime(10000);
  expect(document.title).toBe('linux-gpu [Done] · Fix the settings page');
});

test('completion and focus preserve the human-readable machine label from runtime metadata', () => {
  Object.defineProperty(window, '__CLOUDCLI_NODE__', {
    value: { id: 'linux-gpu', name: '我的 A100' }, configurable: true,
  });
  document.title = getPageTitle(null, { id: 's', summary: 'design', __provider: 'codex' });
  showCompletionTitleIndicator();
  expect(document.title).toBe('我的 A100 [Done] · design');
  returnToWorkspace();
  vi.advanceTimersByTime(2000);
  expect(document.title).toBe('我的 A100 · design');
});

test('returning to the workspace removes only the completion marker, not its node identity', () => {
  document.title = getPageTitle(null, null);
  showCompletionTitleIndicator();
  returnToWorkspace();
  vi.advanceTimersByTime(2000);
  expect(document.title).toBe('linux-gpu');
});

test('completion before title initialization uses the same node-aware fallback', () => {
  document.title = '';
  showCompletionTitleIndicator();
  showCompletionTitleIndicator();
  expect(document.title).toBe('linux-gpu [Done]');
});

test('clearing an old notification does not restore a stale session title', () => {
  document.title = 'linux-gpu · Old session';
  showCompletionTitleIndicator();
  returnToWorkspace();
  document.title = 'linux-gpu · New session';
  vi.advanceTimersByTime(2000);
  expect(document.title).toBe('linux-gpu · New session');
});

test('completion preserves machine and session labels that contain the marker', () => {
  Object.defineProperty(window, '__CLOUDCLI_NODE__', {
    value: { id: 'linux-gpu', name: '[Done] 我的机器' }, configurable: true,
  });
  document.title = getPageTitle(null, { id: 's', summary: '[Done] Session', __provider: 'codex' });
  showCompletionTitleIndicator();
  showCompletionTitleIndicator();
  expect(document.title).toBe('[Done] 我的机器 [Done] · [Done] Session');
  returnToWorkspace();
  vi.advanceTimersByTime(2000);
  expect(document.title).toBe('[Done] 我的机器 · [Done] Session');
});

test('standalone workspaces retain the existing completion prefix', () => {
  Object.defineProperty(window, '__CLOUDCLI_BASE_PATH__', { value: '/', configurable: true });
  document.title = getPageTitle(null, { id: 's', summary: 'Standalone session', __provider: 'codex' });
  showCompletionTitleIndicator();
  expect(document.title).toBe('[Done] Standalone session');
  returnToWorkspace();
  vi.advanceTimersByTime(2000);
  expect(document.title).toBe('Standalone session');
});
