import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import type * as ApiModule from '@/shared/api';
import type { Project, WorkbenchFileContext } from '@/shared/types';
import { ProjectFileTree } from '@/modules/file-tree/ProjectFileTree';

const mocks = vi.hoisted(() => ({
  context: null as WorkbenchFileContext | null,
  listDirectory: vi.fn(),
  resolveFileProject: vi.fn(),
  searchFiles: vi.fn(),
}));
vi.mock('@/shared/codeyWorkbench', () => ({ useWorkbenchFiles: () => mocks.context }));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...await importOriginal<typeof ApiModule>(),
  api: { listDirectory: mocks.listDirectory, resolveFileProject: mocks.resolveFileProject, searchFiles: mocks.searchFiles },
}));

const project: Project = { projectId: 'p1', displayName: 'Repo', path: '/repo', fullPath: '/repo' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const roots = (): WorkbenchFileContext => ({
  projectId: 'portal-project', name: 'My project', sessionId: 's1', currentRootId: 'a:/repo',
  roots: [
    { id: 'a:/repo', nodeId: 'a', projectId: 'p1', name: 'Repo', path: '/repo', kind: 'repository', branch: 'main', machine: 'A', basePath: '/cloudcli/a/', available: true },
    { id: 'b:/repo', nodeId: 'b', projectId: 'p1', name: 'Repo', path: '/repo', kind: 'repository', branch: 'main', machine: 'B', basePath: '/cloudcli/b/', available: true },
    { id: 'a:/worktree', nodeId: 'a', projectId: '', name: 'Fix', path: '/worktree', kind: 'worktree', branch: 'fix', machine: 'A', basePath: '/cloudcli/a/', available: true },
  ],
});

beforeEach(() => {
  mocks.context = roots();
  mocks.listDirectory.mockReset().mockImplementation(async (_id, path) => json({
    entries: path
      ? [{ name: 'nested.ts', path: '/repo/src/nested.ts', type: 'file' }]
      : [{ name: 'readme.md', path: '/repo/readme.md', type: 'file' }, { name: 'src', path: '/repo/src', type: 'directory' }],
    truncated: false,
  }));
  mocks.resolveFileProject.mockReset().mockResolvedValue(json({ project: { ...project, projectId: 'worktree-id', path: '/worktree', fullPath: '/worktree' } }));
  mocks.searchFiles.mockReset().mockResolvedValue(json({ files: [] }));
});

test('lists all project roots, loads only the selected root, and preserves expansion when returning', async () => {
  const open = vi.fn();
  render(<ProjectFileTree selectedProject={project} sessionId="s1" onFileOpen={open} />);
  await screen.findByText('readme.md');
  expect(screen.getByTitle('A · /repo').getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByTitle('B · /repo')).toBeTruthy();
  expect(screen.getByTitle('A · /worktree')).toBeTruthy();
  expect(mocks.listDirectory).toHaveBeenCalledTimes(1);
  expect(mocks.resolveFileProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('src'));
  await screen.findByText('nested.ts');
  fireEvent.click(screen.getByTitle('B · /repo'));
  await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledTimes(3));
  expect(mocks.listDirectory.mock.calls[2][2].apiBasePath).toBe('/cloudcli/b/');
  fireEvent.click(screen.getAllByText('readme.md').at(-1)!);
  expect(open).toHaveBeenLastCalledWith('/repo/readme.md', expect.objectContaining({ projectId: 'p1', fileApiBasePath: '/cloudcli/b/' }));
  fireEvent.click(screen.getByTitle('A · /repo'));
  expect(screen.getByTitle('A · /repo').getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('nested.ts')).toBeTruthy();
  expect(mocks.listDirectory).toHaveBeenCalledTimes(3);
});

test('an unregistered worktree resolves only on selection and uses its own ID for the listing', async () => {
  render(<ProjectFileTree selectedProject={project} sessionId="s1" onFileOpen={vi.fn()} />);
  await screen.findByText('readme.md');
  fireEvent.click(screen.getByTitle('A · /worktree'));
  await waitFor(() => expect(mocks.listDirectory.mock.calls.at(-1)?.[0]).toBe('worktree-id'));
  expect(mocks.resolveFileProject).toHaveBeenCalledWith('/worktree', expect.objectContaining({ apiBasePath: '/cloudcli/a/' }));
});

test('offline roots are visible but disabled; a failing root does not break the others and can retry', async () => {
  mocks.context!.roots[1].available = false;
  mocks.resolveFileProject.mockResolvedValueOnce(json({ error: 'Checkout was removed' }, 404));
  render(<ProjectFileTree selectedProject={project} sessionId="s1" onFileOpen={vi.fn()} />);
  await screen.findByText('readme.md');
  expect(screen.getByTitle('B · /repo').hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByTitle('A · /worktree'));
  await screen.findByText('Checkout was removed');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(mocks.listDirectory.mock.calls.at(-1)?.[0]).toBe('worktree-id'));
});

test('refreshes preserve the browsed root, removal falls back, and stale session context is ignored', async () => {
  const props = { selectedProject: project, sessionId: 's1', onFileOpen: vi.fn() };
  const { rerender } = render(<ProjectFileTree {...props} />);
  await screen.findByText('readme.md');
  fireEvent.click(screen.getByTitle('B · /repo'));
  mocks.context = roots();
  rerender(<ProjectFileTree {...props} />);
  expect(screen.getByTitle('B · /repo').getAttribute('aria-pressed')).toBe('true');
  mocks.context = { ...roots(), roots: roots().roots.filter((root) => root.nodeId !== 'b') };
  rerender(<ProjectFileTree {...props} />);
  expect(screen.getByTitle('A · /repo').getAttribute('aria-pressed')).toBe('true');
  rerender(<ProjectFileTree {...props} sessionId="s2" />);
  expect(screen.queryByTitle('A · /worktree')).toBeNull();
});

test('a chat directory reveal returns to the session machine without later refreshes undoing browsing', async () => {
  const props = { selectedProject: project, sessionId: 's1', onFileOpen: vi.fn() };
  const { rerender } = render(<ProjectFileTree {...props} />);
  await screen.findByText('readme.md');
  fireEvent.click(screen.getByTitle('B · /repo'));
  const revealDirectory = { path: '/repo/src' };
  rerender(<ProjectFileTree {...props} revealDirectory={revealDirectory} />);
  await screen.findByText('nested.ts');
  expect(screen.getByTitle('A · /repo').getAttribute('aria-pressed')).toBe('true');
  expect(mocks.listDirectory.mock.calls.some(([, path, options]) => path === '/repo/src' && options.apiBasePath === '/cloudcli/b/')).toBe(false);
  fireEvent.click(screen.getByTitle('B · /repo'));
  mocks.context = roots();
  rerender(<ProjectFileTree {...props} revealDirectory={revealDirectory} />);
  expect(screen.getByTitle('B · /repo').getAttribute('aria-pressed')).toBe('true');
});

test('a root resolution completed after unmount never installs an old tree', async () => {
  let release!: (response: Response) => void;
  mocks.resolveFileProject.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
  const { unmount } = render(<ProjectFileTree selectedProject={project} sessionId="s1" onFileOpen={vi.fn()} />);
  await screen.findByText('readme.md');
  fireEvent.click(screen.getByTitle('A · /worktree'));
  const signal = mocks.resolveFileProject.mock.calls[0][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => release(json({ project: { ...project, projectId: 'late' } })));
  expect(mocks.listDirectory.mock.calls.some(([id]) => id === 'late')).toBe(false);
});

test('equivalent Windows separators and case do not hide the project roots', async () => {
  mocks.context!.roots[0].path = 'C:\\\\Workspace\\Repo\\';
  render(<ProjectFileTree selectedProject={{ ...project, path: 'c:/workspace/repo', fullPath: 'c:/workspace/repo' }} sessionId="s1" onFileOpen={vi.fn()} />);
  await screen.findByText('readme.md');
  expect(screen.getByTitle('B · /repo')).toBeTruthy();
});
