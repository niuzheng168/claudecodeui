import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useWorkbenchFiles } from '@/shared/codeyWorkbench';
import type { WorkbenchFileContext } from '@/shared/types';

const context: WorkbenchFileContext = {
  projectId: 'p-project', name: 'Project', sessionId: 's1', currentRootId: 'a:/repo',
  roots: [{
    id: 'a:/repo', nodeId: 'a', projectId: 'node-project', name: 'Repo', path: '/repo',
    kind: 'repository', branch: 'main', machine: 'A', basePath: '/cloudcli/a/', available: true,
  }],
};
const post = (value: unknown, source: MessageEventSource | null = window, origin = window.location.origin) => act(() => {
  window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type: 'codey-workbench:project-files', context: value } }));
});

test('project files accept only the embedding same-origin page and can be cleared', () => {
  const { result } = renderHook(() => useWorkbenchFiles());
  post(context);
  expect(result.current).toEqual(context);
  post(null, null);
  post(null, window, 'https://foreign.invalid');
  expect(result.current).toEqual(context);
  post(null);
  expect(result.current).toBeNull();
});

test('invalid roots, missing current root, duplicate identities and unsafe API scopes are rejected', () => {
  const { result } = renderHook(() => useWorkbenchFiles());
  const root = context.roots[0];
  for (const value of [
    { ...context, currentRootId: 'missing' },
    { ...context, roots: [root, root] },
    { ...context, roots: [{ ...root, basePath: 'https://foreign.invalid/' }] },
    { ...context, roots: [{ ...root, basePath: '/cloudcli/../' }] },
    { ...context, roots: [{ ...root, available: 'yes' }] },
    { ...context, roots: [null] },
  ]) {
    post(context);
    post(value);
    expect(result.current).toBeNull();
  }
});
