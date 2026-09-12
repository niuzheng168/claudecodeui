import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';

const project: Project = {
  projectId: 'project-1',
  displayName: 'My Project',
  fullPath: '/projects/my-project',
};

const setWorkspace = (base: string): void => {
  Object.defineProperty(window, '__CLOUDCLI_BASE_PATH__', { value: base, configurable: true });
};

afterEach(() => {
  Reflect.deleteProperty(window, '__CLOUDCLI_BASE_PATH__');
  Reflect.deleteProperty(window, '__CLOUDCLI_NODE__');
  vi.unstubAllEnvs();
});

test('uses the selected session summary as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Fix browser tab title',
    __provider: 'claude',
  };

  assert.equal(getPageTitle(project, session), 'Fix browser tab title');
});

test('uses the selected Cursor session name as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    name: 'Cursor session name',
    __provider: 'cursor',
  };

  assert.equal(getPageTitle(project, session), 'Cursor session name');
});

test('falls back to the project title when no session is selected', () => {
  assert.equal(getPageTitle(project, null), 'My Project - CloudCLI UI');
});

test('falls back to the app title when no project or session is selected', () => {
  assert.equal(getPageTitle(null, null), 'CloudCLI UI');
});

test('falls back to each routed node ID on older portals without machine metadata', () => {
  vi.stubEnv('BASE_URL', '/cloudcli-ui/ui-shared/');
  for (const node of ['zhn-a100', 'jpe2', 'jpe3', 'westus2', 'local', 'n-aaaaaaaaaaaaaaaaaaaaaaaa']) {
    setWorkspace(`/cloudcli/${node}/`);
    assert.equal(getPageTitle(null, null), `cloudcli - ${node}`);
  }
});

test('uses the machine name rather than the opaque enrollment ID, preserving session context', () => {
  const id = 'n-ed8b548e9f433021e91ede0e';
  setWorkspace(`/cloudcli/${id}/`);
  Object.defineProperty(window, '__CLOUDCLI_NODE__', {
    value: { id, name: '  zhn-usw2-1  ' }, configurable: true,
  });
  assert.equal(getPageTitle(null, null), 'cloudcli - zhn-usw2-1');
  assert.equal(getPageTitle(project, null), 'cloudcli - zhn-usw2-1 · My Project');
  assert.equal(getPageTitle(project, {
    id: 'session-1', summary: 'design', __provider: 'codex',
  }), 'cloudcli - zhn-usw2-1 · design');
});

test('ignores foreign, empty or malformed machine metadata', () => {
  setWorkspace('/cloudcli/node-a/');
  for (const identity of [
    { id: 'node-b', name: 'Wrong machine' }, { id: 'node-a', name: ' ' },
    { id: 'node-a', name: 123 }, null,
  ]) {
    Object.defineProperty(window, '__CLOUDCLI_NODE__', { value: identity, configurable: true });
    assert.equal(getPageTitle(null, null), 'cloudcli - node-a');
  }
  setWorkspace('/');
  Object.defineProperty(window, '__CLOUDCLI_NODE__', {
    value: { id: 'node-a', name: 'A machine' }, configurable: true,
  });
  assert.equal(getPageTitle(null, null), 'CloudCLI UI');
});

test('keeps node identity first when selecting a project or a session', () => {
  setWorkspace('/cloudcli/zhn-a100/');
  assert.equal(getPageTitle(project, null), 'cloudcli - zhn-a100 · My Project');
  assert.equal(getPageTitle(project, {
    id: 'session-1', summary: 'Fix browser tab title', __provider: 'codex',
  }), 'cloudcli - zhn-a100 · Fix browser tab title');
  assert.equal(getPageTitle(project, {
    id: 'session-2', name: 'Cursor session name', __provider: 'cursor',
  }), 'cloudcli - zhn-a100 · Cursor session name');
});

test('supports older node-scoped builds and preserves the runtime node spelling', () => {
  vi.stubEnv('BASE_URL', '/cloudcli/zhn-A100/');
  assert.equal(getPageTitle(null, null), 'cloudcli - zhn-A100');
  setWorkspace('/cloudcli/jpe2');
  assert.equal(getPageTitle(null, null), 'cloudcli - jpe2');
});

test('does not mistake other deployment paths or an uninitialized shared release for a node', () => {
  for (const base of ['/', '/custom-prefix/', '/cloudcli-ui/ui-shared/', '/cloudcli/', '/cloudcli/node-a/session/example/']) {
    setWorkspace(base);
    assert.equal(getPageTitle(null, null), 'CloudCLI UI');
  }
});
