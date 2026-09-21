import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useCodeEditorDocument } from '@/modules/code-editor/hooks/useCodeEditorDocument';
import type { CodeEditorFile } from '@/shared/types';

const { readFile, saveFile } = vi.hoisted(() => ({
  readFile: vi.fn(),
  saveFile: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: { readFile, saveFile } }));

const FILE: CodeEditorFile = {
  name: 'design.md',
  path: '/workspace/related-worktree/docs/design.md',
  projectId: 'main-project',
};

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status, statusText, headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  readFile.mockReset().mockImplementation(async () => jsonResponse({ content: '# design' }));
  saveFile.mockReset().mockImplementation(async () => jsonResponse({ success: true }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

test('loads and saves an absolute worktree link using the original project id', async () => {
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(readFile).toHaveBeenCalledWith('main-project', FILE.path);
  expect(result.current.content).toBe('# design');
  act(() => result.current.setContent('# updated design'));
  await act(() => result.current.handleSave());
  expect(saveFile).toHaveBeenCalledWith('main-project', FILE.path, '# updated design');
  expect(result.current.saveSuccess).toBe(true);
});

test('shows the backend denial reason and never saves or downloads the diagnostic buffer', async () => {
  const reason = 'Path must be under the project root or a related Git worktree';
  readFile.mockResolvedValueOnce(jsonResponse({ error: reason }, 403, 'Forbidden'));
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.content).toContain(`403 Forbidden: ${reason}`);
  expect(result.current.content).toContain(FILE.path);

  // Even editing the error comment does not turn it into a safely loaded file.
  act(() => result.current.setContent('not a real document'));
  await act(() => result.current.handleSave());
  expect(saveFile).not.toHaveBeenCalled();
  expect(result.current.saveError).toContain(reason);
  expect(() => result.current.handleDownload()).not.toThrow();
});

test('reads structured error.message responses rather than displaying [object Object]', async () => {
  readFile.mockResolvedValueOnce(jsonResponse({
    error: { code: 'permission_denied', message: 'Worktree is outside the workspace root' },
  }, 403, 'Forbidden'));
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.content).toContain('403 Forbidden: Worktree is outside the workspace root');
  expect(result.current.content).not.toContain('[object Object]');
});

test.each([
  { body: '<html>private proxy diagnostics</html>', contentType: 'text/html' },
  { body: '{invalid', contentType: 'application/json' },
  { body: '', contentType: 'application/json' },
  { body: '{"error":{"code":"unavailable"}}', contentType: 'application/problem+json' },
])('keeps the HTTP error when the response has no usable message: $body', async ({ body, contentType }) => {
  readFile.mockResolvedValueOnce(new Response(body, {
    status: 503, statusText: 'Service Unavailable', headers: { 'content-type': contentType },
  }));
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.content).toContain('Failed to load file: 503 Service Unavailable');
  expect(result.current.content).not.toContain('private proxy diagnostics');
  expect(result.current.content).not.toContain('Unexpected');
});

test('invalid successful responses cannot become editable file contents', async () => {
  readFile.mockResolvedValueOnce(jsonResponse({ success: true }));
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.content).toContain('Invalid file response: missing text content');
  await act(() => result.current.handleSave());
  expect(saveFile).not.toHaveBeenCalled();
});

test('an empty file is valid and can still be saved', async () => {
  readFile.mockResolvedValueOnce(jsonResponse({ content: '' }));
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.content).toBe('');
  await act(() => result.current.handleSave());
  expect(saveFile).toHaveBeenCalledWith(FILE.projectId, FILE.path, '');
});

test('saving is blocked until the pending read has completed', async () => {
  let finishRead!: (response: Response) => void;
  readFile.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }));
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await act(() => result.current.handleSave());
  expect(saveFile).not.toHaveBeenCalled();
  await act(async () => { finishRead(jsonResponse({ content: '# finished' })); });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(() => result.current.handleSave());
  expect(saveFile).toHaveBeenCalledWith(FILE.projectId, FILE.path, '# finished');
});

test('a successful file switch clears a prior load failure and permits saving', async () => {
  readFile.mockResolvedValueOnce(jsonResponse({ error: 'Permission denied' }, 403, 'Forbidden'));
  const { result, rerender } = renderHook(
    (file) => useCodeEditorDocument({ file }),
    { initialProps: FILE },
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(() => result.current.handleSave());
  expect(result.current.saveError).toContain('Permission denied');

  const nextFile = { ...FILE, path: '/workspace/related-worktree/docs/next.md', name: 'next.md' };
  rerender(nextFile);
  await waitFor(() => expect(result.current.content).toBe('# design'));
  expect(result.current.saveError).toBeNull();
  await act(() => result.current.handleSave());
  expect(saveFile).toHaveBeenCalledWith(FILE.projectId, nextFile.path, '# design');
});

test.each([200, 403])('a late %i response for the previous file cannot replace the current document', async (status) => {
  let finishOldRead!: (response: Response) => void;
  readFile.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOldRead = resolve; }));
  const { result, rerender } = renderHook(
    (file) => useCodeEditorDocument({ file }),
    { initialProps: FILE },
  );
  const nextFile = { ...FILE, path: '/workspace/related-worktree/docs/next.md', name: 'next.md' };
  rerender(nextFile);
  await waitFor(() => expect(result.current.content).toBe('# design'));
  await act(async () => {
    finishOldRead(jsonResponse(
      status === 200 ? { content: '# stale' } : { error: 'stale permission error' },
      status,
      status === 200 ? 'OK' : 'Forbidden',
    ));
  });
  expect(result.current.content).toBe('# design');
  await act(() => result.current.handleSave());
  expect(saveFile).toHaveBeenCalledWith(FILE.projectId, nextFile.path, '# design');
});

test('complete diff snapshots remain usable without reading the file', async () => {
  const file: CodeEditorFile = {
    ...FILE, diffInfo: { old_string: '# old', new_string: '# diff snapshot' },
  };
  const { result } = renderHook(() => useCodeEditorDocument({ file }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(readFile).not.toHaveBeenCalled();
  expect(result.current.content).toBe('# diff snapshot');
  await act(() => result.current.handleSave());
  expect(saveFile).toHaveBeenCalledWith(FILE.projectId, FILE.path, '# diff snapshot');
});

test.each(['design.png', 'archive.zip'])('does not load or save %s as text', async (name) => {
  const { result } = renderHook(() => useCodeEditorDocument({ file: { ...FILE, name } }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(readFile).not.toHaveBeenCalled();
  expect(result.current.content).toBe('');
  await act(() => result.current.handleSave());
  expect(saveFile).not.toHaveBeenCalled();
});

test('save errors also preserve the backend message and HTTP status', async () => {
  saveFile.mockResolvedValueOnce(jsonResponse({ error: { message: 'Permission denied' } }, 403, 'Forbidden'));
  const { result } = renderHook(() => useCodeEditorDocument({ file: FILE }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(() => result.current.handleSave());
  expect(result.current.saveError).toBe('Save failed: 403 Forbidden: Permission denied');
  expect(result.current.content).toBe('# design');
});
