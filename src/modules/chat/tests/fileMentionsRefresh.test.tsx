import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The `@` dropdown searches the project's files on the server, so a project
 * too large to list in the browser still offers them. Regression guard for
 * #1367 too: a file added after the last `@` (an upload, an agent edit, a
 * terminal command) must be offered the next time the user types `@`.
 */

const searchFiles = vi.fn();
const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    searchFiles: (...args: unknown[]) => searchFiles(...args),
    getFiles: (...args: unknown[]) => getFiles(...args),
  },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const project: Project = { projectId: 'p1', displayName: 'project', fullPath: '/home/user/project' };

const answer = (paths: string[]) => ({
  ok: true,
  json: async () => ({
    files: paths.map((filePath) => ({ name: filePath.split('/').pop(), path: filePath })),
    truncated: false,
  }),
});

// The project's files, searched the way the server does.
let projectFiles: string[] = [];
const searchProject = (_projectId: string, { query }: { query: string }) =>
  Promise.resolve(answer(projectFiles.filter((filePath) => filePath.toLowerCase().includes(query.toLowerCase()))));

// A search the test answers by hand, to hold it in flight.
const deferredAnswer = () => {
  let resolve: (paths: string[]) => void = () => {};
  const promise = new Promise<ReturnType<typeof answer>>((resolvePromise) => {
    resolve = (paths) => resolvePromise(answer(paths));
  });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  // The dropdown ignores keys while an IME composition is open.
  ({ key, nativeEvent: { isComposing: false }, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const searchedFor = (callIndex: number) => searchFiles.mock.calls[callIndex]?.[1];

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const setInput = vi.fn();
  const hook = renderHook(
    ({ input }: { input: string }) => useFileMentions({ selectedProject: project, input, setInput, textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const press = (key: string) => {
    let handled = false;
    act(() => {
      handled = hook.result.current.handleFileMentionsKeyDown(keyEvent(key));
    });
    return handled;
  };

  const shownPaths = () => hook.result.current.filteredFiles.map((file) => file.path);

  return { ...hook, type, press, shownPaths, setInput };
};

beforeEach(() => {
  searchFiles.mockReset();
  searchFiles.mockImplementation(searchProject);
  getFiles.mockReset();
  projectFiles = [];
});

test('a node from before file search gets its whole tree filtered here, loaded again with each `@`', async () => {
  // Such a node serves its app page for a route it does not have.
  searchFiles.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const tree = (names: string[]) => ({
    ok: true,
    json: async () => [
      { type: 'directory', name: 'src', children: names.map((name) => ({ type: 'file', name })) },
      { type: 'file', name: 'README.md' },
    ],
  });
  getFiles.mockResolvedValueOnce(tree(['app.ts'])).mockResolvedValue(tree(['app.ts', 'added.ts']));
  const { type, shownPaths } = renderMentions();

  type('@');
  await waitFor(() => assert.deepEqual(shownPaths(), ['src/app.ts', 'README.md']));
  type('@ap');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(shownPaths(), ['src/app.ts']);
  assert.equal(getFiles.mock.calls.length, 1);
  assert.equal(searchFiles.mock.calls.length, 1);

  type('@ap ');
  type('@ap @add');
  await waitFor(() => assert.deepEqual(shownPaths(), ['src/added.ts']));
  assert.equal(getFiles.mock.calls.length, 2);
  assert.equal(searchFiles.mock.calls.length, 1);
});

test('nothing is searched before `@`, and each `@` lists the project again', async () => {
  projectFiles = ['a.txt', 'src/b.txt'];
  const { type, shownPaths } = renderMentions();
  type('hello');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(searchFiles.mock.calls.length, 0);

  type('hello @');
  await waitFor(() => assert.deepEqual(shownPaths(), ['a.txt', 'src/b.txt']));
  assert.deepEqual(searchFiles.mock.calls[0].slice(0, 2), ['p1', { query: '', limit: 20, refresh: true }]);

  // A file uploaded while the dropdown was closed.
  type('hello @ ');
  projectFiles = ['a.txt', 'src/b.txt', 'uploaded.txt'];
  type('hello @ @upl');
  await waitFor(() => assert.deepEqual(shownPaths(), ['uploaded.txt']));
  assert.deepEqual(searchedFor(1), { query: 'upl', limit: 20, refresh: true });
});

test('typing the query searches again once typing pauses, without listing the project again', async () => {
  projectFiles = ['a.txt', 'b.txt'];
  const { type, shownPaths } = renderMentions();

  type('@');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@a');
  type('@a.');
  type('@a.t');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  assert.deepEqual(searchedFor(1), { query: 'a.t', limit: 20, refresh: false });
  await waitFor(() => assert.deepEqual(shownPaths(), ['a.txt']));

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(searchFiles.mock.calls.length, 2);
});

test('the files found narrow at once to what is typed while the next search is on its way', async () => {
  projectFiles = ['a.txt', 'ab.txt', 'b.txt'];
  const next = deferredAnswer();
  searchFiles.mockImplementationOnce(searchProject).mockReturnValueOnce(next.promise);
  const { type, shownPaths } = renderMentions();

  type('@');
  await waitFor(() => assert.deepEqual(shownPaths(), ['a.txt', 'ab.txt', 'b.txt']));
  type('@a');
  assert.deepEqual(shownPaths(), ['a.txt', 'ab.txt']);
  type('@ab');
  assert.deepEqual(shownPaths(), ['ab.txt']);

  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  await act(async () => {
    next.resolve(['ab.txt', 'deep/ab.md']);
  });
  assert.deepEqual(shownPaths(), ['ab.txt', 'deep/ab.md']);
});

test('an older search that lands after a newer one cannot overwrite it', async () => {
  projectFiles = ['a.txt'];
  const older = deferredAnswer();
  const newer = deferredAnswer();
  searchFiles.mockImplementationOnce(searchProject).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const { type, shownPaths } = renderMentions();

  type('@');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@x');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  type('@xy');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 3));

  // The newer search superseded the older one.
  assert.equal((searchFiles.mock.calls[1][2] as { signal: AbortSignal }).signal.aborted, true);

  await act(async () => {
    newer.resolve(['xy-newer.txt']);
  });
  await waitFor(() => assert.deepEqual(shownPaths(), ['xy-newer.txt']));

  await act(async () => {
    older.resolve(['xy-older.txt']);
  });
  assert.deepEqual(shownPaths(), ['xy-newer.txt']);
});

test('Escape closes the dropdown, and a search landing after it does not bring files back', async () => {
  const pending = deferredAnswer();
  searchFiles.mockReturnValueOnce(pending.promise);
  projectFiles = ['a.txt', 'new.txt'];
  const { result, type, press, shownPaths } = renderMentions();

  type('mail me at foo@');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  assert.equal(result.current.showFileDropdown, true);

  assert.equal(press('Escape'), true);
  assert.equal(result.current.showFileDropdown, false);
  assert.equal((searchFiles.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted, true);

  await act(async () => {
    pending.resolve(['a.txt', 'new.txt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Still closed, so the next Enter reaches the composer and sends the message.
  assert.equal(result.current.showFileDropdown, false);
  assert.deepEqual(shownPaths(), []);
  assert.equal(press('Enter'), false);

  // Typing on inside the query opens the dropdown again, which lists the project again.
  type('mail me at foo@ne');
  await waitFor(() => assert.deepEqual(shownPaths(), ['new.txt']));
  assert.deepEqual(searchedFor(1), { query: 'ne', limit: 20, refresh: true });
});

test('Enter inserts the highlighted file, or the first one', async () => {
  projectFiles = ['a.txt', 'src/ab.txt'];
  const { type, press, setInput } = renderMentions();

  type('see @a');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  await waitFor(() => assert.equal(press('ArrowDown'), true));
  press('ArrowDown');
  assert.equal(press('Enter'), true);
  assert.equal(setInput.mock.lastCall?.[0], 'see src/ab.txt ');

  type('see @a');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  await waitFor(() => assert.equal(press('Tab'), true));
  assert.equal(setInput.mock.lastCall?.[0], 'see a.txt ');
});

test('the highlight stays on its file when a newer search lands', async () => {
  projectFiles = ['a.txt', 'b.txt'];
  const refreshed = deferredAnswer();
  searchFiles.mockImplementationOnce(searchProject).mockReturnValueOnce(refreshed.promise);
  const { result, type, press, setInput } = renderMentions();

  type('@');
  await waitFor(() => assert.equal(result.current.filteredFiles.length, 2));
  type('@ ');
  // The next `@` shows the files found last time while the project is listed again.
  type('@ @');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  press('ArrowDown');
  press('ArrowDown');
  assert.equal(result.current.selectedFileIndex, 1);

  await act(async () => {
    refreshed.resolve(['new.txt', 'a.txt', 'b.txt']);
  });
  assert.equal(result.current.selectedFileIndex, 2);
  press('Enter');
  assert.equal(setInput.mock.lastCall?.[0], '@ b.txt ');
});

test('a search the server refuses offers nothing and throws nothing', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  searchFiles.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'failed' }) });
  const { result, type, shownPaths } = renderMentions();

  type('@a');
  await waitFor(() => assert.equal(logged.mock.calls.length, 1));
  assert.equal(result.current.showFileDropdown, true);
  assert.deepEqual(shownPaths(), []);
  logged.mockRestore();
});
