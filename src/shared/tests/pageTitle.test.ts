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
  for (const node of ['linux-gpu', 'node-east-1', 'node-east-2', 'node-west', 'local', 'n-aaaaaaaaaaaaaaaaaaaaaaaa']) {
    setWorkspace(`/cloudcli/${node}/`);
    assert.equal(getPageTitle(null, null), node);
  }
});

test('uses the machine name rather than the opaque enrollment ID, preserving session context', () => {
  const id = 'n-111111111111111111111111';
  setWorkspace(`/cloudcli/${id}/`);
  Object.defineProperty(window, '__CLOUDCLI_NODE__', {
    value: { id, name: '  node-west  ' }, configurable: true,
  });
  assert.equal(getPageTitle(null, null), 'node-west');
  assert.equal(getPageTitle(project, null), 'node-west · My Project');
  assert.equal(getPageTitle(project, {
    id: 'session-1', summary: 'design', __provider: 'codex',
  }), 'node-west · design');
});

test('ignores foreign, empty or malformed machine metadata', () => {
  setWorkspace('/cloudcli/node-a/');
  for (const identity of [
    { id: 'node-b', name: 'Wrong machine' }, { id: 'node-a', name: ' ' },
    { id: 'node-a', name: 123 }, null,
  ]) {
    Object.defineProperty(window, '__CLOUDCLI_NODE__', { value: identity, configurable: true });
    assert.equal(getPageTitle(null, null), 'node-a');
  }
  setWorkspace('/');
  Object.defineProperty(window, '__CLOUDCLI_NODE__', {
    value: { id: 'node-a', name: 'A machine' }, configurable: true,
  });
  assert.equal(getPageTitle(null, null), 'CloudCLI UI');
});

test('keeps node identity first when selecting a project or a session', () => {
  setWorkspace('/cloudcli/linux-gpu/');
  assert.equal(getPageTitle(project, null), 'linux-gpu · My Project');
  assert.equal(getPageTitle(project, {
    id: 'session-1', summary: 'Fix browser tab title', __provider: 'codex',
  }), 'linux-gpu · Fix browser tab title');
  assert.equal(getPageTitle(project, {
    id: 'session-2', name: 'Cursor session name', __provider: 'cursor',
  }), 'linux-gpu · Cursor session name');
});

test('supports older node-scoped builds and preserves the runtime node spelling', () => {
  vi.stubEnv('BASE_URL', '/cloudcli/linux-gpu/');
  assert.equal(getPageTitle(null, null), 'linux-gpu');
  setWorkspace('/cloudcli/node-east-1');
  assert.equal(getPageTitle(null, null), 'node-east-1');
});

test('keeps each machine name visible at the start of long mobile tab titles', () => {
  for (const [index, name] of ['devbox', 'node-east-1', 'node-east-2', 'node-west'].entries()) {
    const id = `n-${index.toString(16).padStart(24, '0')}`;
    setWorkspace(`/cloudcli/${id}/`);
    Object.defineProperty(window, '__CLOUDCLI_NODE__', {
      value: { id, name }, configurable: true,
    });
    const title = getPageTitle(project, {
      id: 'session-1', summary: 'A long conversation summary that will be truncated on a phone', __provider: 'codex',
    });
    assert.equal(title.slice(0, name.length), name);
    assert.equal(title, `${name} · A long conversation summary that will be truncated on a phone`);
  }
});

test('does not mistake other deployment paths or an uninitialized shared release for a node', () => {
  for (const base of ['/', '/custom-prefix/', '/cloudcli-ui/ui-shared/', '/cloudcli/', '/cloudcli/node-a/session/example/']) {
    setWorkspace(base);
    assert.equal(getPageTitle(null, null), 'CloudCLI UI');
  }
});
