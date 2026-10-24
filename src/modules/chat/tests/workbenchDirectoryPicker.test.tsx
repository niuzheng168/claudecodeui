import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import WorkbenchDirectoryPicker from '@/modules/chat/transcript/WorkbenchDirectoryPicker';
import {
  WORKBENCH_CHOOSE_DIRECTORY_MESSAGE,
  WORKBENCH_DIRECTORIES_MESSAGE,
} from '@/shared/codeyWorkbench';

/**
 * The Codey Workbench offers the directories a new session may start in, on
 * any of the user's machines; the new session page shows them as a card under
 * the model card and hands a pick back. In a test the page is its own parent.
 */

const DIRECTORIES = [
  { machine: 'zhn-jpe-2', name: 'codey', path: '/home/zhn/g/codey', worktree: '', available: true },
  { machine: 'zhn-jpe-2', name: 'codey-ui', path: '/home/zhn/g/codey/.claude/worktrees/ui', worktree: 'ui', available: true },
  { machine: 'zhn-usw2-1', name: 'codey', path: '/home/zhn/g/codey', worktree: '', available: false },
];

const offer = (data: Record<string, unknown>, origin = window.location.origin) => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: WORKBENCH_DIRECTORIES_MESSAGE, ...data },
      origin,
      source: window,
    }));
  });
};

const isShown = (text: string) => screen.queryByText(text) !== null;

beforeEach(() => {
  // cmdk measures its list and scrolls the highlighted row into view; jsdom does neither.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  offer({ directories: null });
  vi.unstubAllGlobals();
});

test('the card appears once the Workbench offers several directories', () => {
  render(<WorkbenchDirectoryPicker />);
  assert.equal(screen.queryByRole('button'), null);

  offer({ directories: DIRECTORIES.slice(0, 1), selected: 0 });
  assert.equal(screen.queryByRole('button'), null, 'one directory leaves nothing to choose');

  offer({ directories: DIRECTORIES, selected: 1 });
  const card = screen.getByRole('button');
  assert.match(card.textContent ?? '', /zhn-jpe-2·ui\/home\/zhn\/g\/codey\/\.claude\/worktrees\/ui/);

  offer({ directories: null });
  assert.equal(screen.queryByRole('button'), null);
});

test('offers from another origin or with a bad selection are ignored', () => {
  render(<WorkbenchDirectoryPicker />);
  offer({ directories: DIRECTORIES, selected: 0 }, 'https://elsewhere.example');
  assert.equal(screen.queryByRole('button'), null);

  offer({ directories: DIRECTORIES, selected: 3 });
  assert.equal(screen.queryByRole('button'), null);
});

test('picking another directory hands it back to the Workbench', () => {
  const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  render(<WorkbenchDirectoryPicker />);
  offer({ directories: DIRECTORIES, selected: 0 });

  fireEvent.click(screen.getByRole('button'));
  screen.getByText('Choose a directory');
  // Grouped by machine; the unreachable machine's directory is listed but not offered.
  assert.ok(isShown('zhn-usw2-1'));
  const unavailable = screen.getByText('Unavailable').closest('[cmdk-item]');
  assert.equal(unavailable?.getAttribute('aria-disabled'), 'true');

  fireEvent.click(screen.getByText('ui'));
  assert.deepEqual(postMessage.mock.calls, [[
    { type: WORKBENCH_CHOOSE_DIRECTORY_MESSAGE, index: 1 },
    window.location.origin,
  ]]);
  assert.equal(isShown('Choose a directory'), false);
});

test('picking the current directory only closes the list', () => {
  const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  render(<WorkbenchDirectoryPicker />);
  offer({ directories: DIRECTORIES, selected: 0 });

  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(within(screen.getByRole('dialog')).getAllByText('codey')[0]);
  assert.equal(postMessage.mock.calls.length, 0);
  assert.equal(isShown('Choose a directory'), false);
});
