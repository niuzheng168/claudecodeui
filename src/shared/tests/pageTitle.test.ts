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

test('uses each routed node ID rather than the generic app name or shared asset release', () => {
  vi.stubEnv('BASE_URL', '/cloudcli-ui/ui-shared/');
  for (const node of ['linux-gpu', 'node-east-1', 'node-east-2', 'node-west', 'local', 'n-aaaaaaaaaaaaaaaaaaaaaaaa']) {
    setWorkspace(`/cloudcli/${node}/`);
    assert.equal(getPageTitle(null, null), `cloudcli - ${node}`);
  }
});

test('keeps node identity first when selecting a project or a session', () => {
  setWorkspace('/cloudcli/linux-gpu/');
  assert.equal(getPageTitle(project, null), 'cloudcli - linux-gpu · My Project');
  assert.equal(getPageTitle(project, {
    id: 'session-1', summary: 'Fix browser tab title', __provider: 'codex',
  }), 'cloudcli - linux-gpu · Fix browser tab title');
  assert.equal(getPageTitle(project, {
    id: 'session-2', name: 'Cursor session name', __provider: 'cursor',
  }), 'cloudcli - linux-gpu · Cursor session name');
});

test('supports older node-scoped builds and preserves the runtime node spelling', () => {
  vi.stubEnv('BASE_URL', '/cloudcli/linux-gpu/');
  assert.equal(getPageTitle(null, null), 'cloudcli - linux-gpu');
  setWorkspace('/cloudcli/node-east-1');
  assert.equal(getPageTitle(null, null), 'cloudcli - node-east-1');
});

test('does not mistake other deployment paths or an uninitialized shared release for a node', () => {
  for (const base of ['/', '/custom-prefix/', '/cloudcli-ui/ui-shared/', '/cloudcli/', '/cloudcli/node-a/session/example/']) {
    setWorkspace(base);
    assert.equal(getPageTitle(null, null), 'CloudCLI UI');
  }
});
