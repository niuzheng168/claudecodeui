import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project } from '@/shared/types';

/**
 * The file tree lists the project root, then each folder when it is opened,
 * so a project of any size shows. A node from before that serves its app page
 * for the folder route and gets the whole tree loaded, as before.
 */

const ROOT = '/home/u/project';

const api = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  getFiles: vi.fn(),
  searchFiles: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api }));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT, path: ROOT };

const entry = (type: 'file' | 'directory', relativePath: string) => ({
  type,
  name: relativePath.split('/').pop(),
  path: `${ROOT}/${relativePath}`,
  size: 12,
  modified: '2026-11-10T00:00:00.000Z',
  permissionsRwx: 'rw-r--r--',
});

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const appPageResponse = () => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new SyntaxError('Unexpected token <');
  },
  text: async () => '<!doctype html>',
});

/** Answers folder listings from `folders`, by path relative to the project ('' for the root). */
function serveFolders(folders: Record<string, unknown>) {
  api.listDirectory.mockImplementation(async (_projectId: string, folderPath: string | null) => {
    const relativePath = folderPath === null ? '' : folderPath.slice(ROOT.length + 1);
    const listing = folders[relativePath];
    return listing ? jsonResponse(listing) : jsonResponse({ error: 'Folder not found' }, 404);
  });
}

const listedFolders = () => api.listDirectory.mock.calls.map(([, folderPath]) => folderPath);

beforeEach(() => {
  api.listDirectory.mockReset();
  api.getFiles.mockReset();
  api.searchFiles.mockReset();
});

test('the root is listed first, and a folder only once it is opened', async () => {
  serveFolders({
    '': { entries: [entry('directory', 'src'), entry('file', 'README.md')], truncated: false },
    src: { entries: [entry('file', 'src/index.ts')], truncated: false },
  });

  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('README.md')));
  assert.deepEqual(listedFolders(), [null]);
  assert.equal(screen.queryByText('index.ts'), null);

  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.ok(screen.getByText('index.ts')));
  assert.deepEqual(listedFolders(), [null, `${ROOT}/src`]);

  // Closing and reopening shows the loaded entries without listing again.
  fireEvent.click(screen.getByText('src'));
  assert.equal(screen.queryByText('index.ts'), null);
  fireEvent.click(screen.getByText('src'));
  assert.ok(screen.getByText('index.ts'));
  assert.equal(api.listDirectory.mock.calls.length, 2);
  assert.equal(api.getFiles.mock.calls.length, 0);
});

test('a node without folder listing gets the whole tree loaded, as before', async () => {
  api.listDirectory.mockResolvedValue(appPageResponse());
  api.getFiles.mockResolvedValue(jsonResponse([
    { ...entry('directory', 'src'), children: [entry('file', 'src/index.ts')] },
  ]));

  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('src')));
  fireEvent.click(screen.getByText('src'));
  assert.ok(screen.getByText('index.ts'));
  assert.equal(api.listDirectory.mock.calls.length, 1);
  assert.equal(api.getFiles.mock.calls.length, 1);
});

test('the server refusing the whole tree is reported, as before', async () => {
  api.listDirectory.mockResolvedValue(appPageResponse());
  api.getFiles.mockResolvedValue(jsonResponse({ error: 'Project file tree exceeds the 10,000 entry limit.' }, 413));

  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('Project file tree exceeds the 10,000 entry limit.')));
});

test('revealing a nested folder opens each level as it loads', async () => {
  serveFolders({
    '': { entries: [entry('directory', 'src')], truncated: false },
    src: { entries: [entry('directory', 'src/modules'), entry('file', 'src/main.ts')], truncated: false },
    'src/modules': { entries: [entry('file', 'src/modules/index.ts')], truncated: false },
  });

  render(<FileTree selectedProject={project} revealDirectory={{ path: 'src/modules/' }} />);

  await waitFor(() => assert.ok(screen.getByText('index.ts')));
  assert.ok(screen.getByText('main.ts'));
  assert.deepEqual(listedFolders(), [null, `${ROOT}/src`, `${ROOT}/src/modules`]);
});

test('a folder that cannot be listed says why, and one cut short says so', async () => {
  serveFolders({
    '': { entries: [entry('directory', 'exports'), entry('directory', 'locked')], truncated: true },
    exports: { entries: [entry('file', 'exports/0001.json')], truncated: true },
  });

  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('Only the first 2 entries are shown')));
  fireEvent.click(screen.getByText('exports'));
  await waitFor(() => assert.ok(screen.getByText('Only the first 1 entries are shown')));
  fireEvent.click(screen.getByText('locked'));
  await waitFor(() => assert.ok(screen.getByText('Folder not found')));
});

test('a refresh lists the root and the open folders again, keeping them open', async () => {
  let srcEntries = [entry('file', 'src/index.ts')];
  api.listDirectory.mockImplementation(async (_projectId: string, folderPath: string | null) => (
    folderPath === null
      ? jsonResponse({ entries: [entry('directory', 'src'), entry('directory', 'docs')], truncated: false })
      : jsonResponse({ entries: folderPath === `${ROOT}/src` ? srcEntries : [], truncated: false })
  ));

  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('src')));
  fireEvent.click(screen.getByText('src'));
  await waitFor(() => assert.ok(screen.getByText('index.ts')));

  srcEntries = [...srcEntries, entry('file', 'src/added.ts')];
  api.listDirectory.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  await waitFor(() => assert.ok(screen.getByText('added.ts')));
  assert.ok(screen.getByText('index.ts'));
  assert.deepEqual(listedFolders(), [null, `${ROOT}/src`]);
});

test('search asks the server and shows what it found inside its folders', async () => {
  serveFolders({ '': { entries: [entry('directory', 'src')], truncated: false } });
  api.searchFiles.mockResolvedValue(jsonResponse({
    files: [{
      name: 'Button.tsx',
      path: 'src/components/Button.tsx',
      absolutePath: `${ROOT}/src/components/Button.tsx`,
    }],
    truncated: false,
  }));
  const onFileOpen = vi.fn();

  render(<FileTree selectedProject={project} onFileOpen={onFileOpen} />);
  await waitFor(() => assert.ok(screen.getByText('src')));

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'button' } });

  await waitFor(() => assert.ok(screen.getByText('Button.tsx')));
  assert.ok(screen.getByText('components'));
  assert.deepEqual(api.searchFiles.mock.calls[0]?.slice(0, 2), ['p1', { query: 'button', limit: 100, refresh: true }]);

  fireEvent.click(screen.getByText('Button.tsx'));
  assert.deepEqual(onFileOpen.mock.calls, [[`${ROOT}/src/components/Button.tsx`]]);
});
