import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { getPageTitle } from '@/shared/utils';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  Object.defineProperty(window, '__CLOUDCLI_BASE_PATH__', { value: '/cloudcli/zhn-a100/', configurable: true });
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
  document.title = '';
});

test('background completion preserves the node prefix and selected session context', () => {
  document.title = getPageTitle(null, {
    id: 'session-1', summary: 'Fix the settings page', __provider: 'codex',
  });
  showCompletionTitleIndicator();
  expect(document.title).toBe('[Done] cloudcli - zhn-a100 · Fix the settings page');
  vi.advanceTimersByTime(10000);
  expect(document.title).toBe('[Done] cloudcli - zhn-a100 · Fix the settings page');
});

test('returning to the workspace removes only the completion marker, not its node identity', () => {
  document.title = getPageTitle(null, null);
  showCompletionTitleIndicator();
  returnToWorkspace();
  vi.advanceTimersByTime(2000);
  expect(document.title).toBe('cloudcli - zhn-a100');
});

test('completion before title initialization uses the same node-aware fallback', () => {
  document.title = '';
  showCompletionTitleIndicator();
  showCompletionTitleIndicator();
  expect(document.title).toBe('[Done] cloudcli - zhn-a100');
});

test('clearing an old notification does not restore a stale session title', () => {
  document.title = 'cloudcli - zhn-a100 · Old session';
  showCompletionTitleIndicator();
  returnToWorkspace();
  document.title = 'cloudcli - zhn-a100 · New session';
  vi.advanceTimersByTime(2000);
  expect(document.title).toBe('cloudcli - zhn-a100 · New session');
});
