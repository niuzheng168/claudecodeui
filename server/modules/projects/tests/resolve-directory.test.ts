import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProjectDirectory } from '@/modules/projects/services/project-management.service.js';

const row = { project_id: 'p1', project_path: '/workspace/repo', custom_project_name: 'Repo', isStarred: 0, isArchived: 0 };
const dependencies = () => ({
  validatePath: async (resolvedPath: string) => ({ valid: true, resolvedPath }),
  isDirectory: async () => true,
  getProjectByPath: () => row,
  persistProjectPath: () => { throw new Error('Existing projects must not be changed'); },
});

test('resolving a directory reuses its project ID and keeps archived projects archived', async () => {
  for (const isArchived of [0, 1]) {
    const result = await resolveProjectDirectory('/workspace/repo', {
      ...dependencies(), getProjectByPath: () => ({ ...row, isArchived }),
    });
    assert.equal(result.project.projectId, 'p1');
    assert.equal(result.project.isArchived, Boolean(isArchived));
    assert.equal(result.project.displayName, 'Repo');
  }
});

test('registers a valid existing folder only on first access, without creating directories', async () => {
  const calls: unknown[] = [];
  const result = await resolveProjectDirectory('/workspace/repo', {
    ...dependencies(),
    getProjectByPath: () => null,
    persistProjectPath: (path, name) => {
      calls.push([path, name]);
      return { outcome: 'created', project: row };
    },
  });
  assert.deepEqual(calls, [['/workspace/repo', null]]);
  assert.equal(result.project.fullPath, row.project_path);
});

test('missing folders, files and inaccessible worktrees are not recreated or registered', async () => {
  for (const isDirectory of [async () => false, async () => { throw new Error('ENOENT'); }]) {
    await assert.rejects(resolveProjectDirectory('/workspace/repo', {
      ...dependencies(), isDirectory,
    }), { code: 'PROJECT_DIRECTORY_NOT_FOUND', statusCode: 404 });
  }
});

test('rejects relative paths and workspace-policy denial before touching the directory', async () => {
  for (const path of ['', '../outside', 'repo']) {
    await assert.rejects(resolveProjectDirectory(path, dependencies()), { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
  }
  await assert.rejects(resolveProjectDirectory('/outside', {
    ...dependencies(),
    validatePath: async () => ({ valid: false, resolvedPath: '' }),
    isDirectory: async () => { throw new Error('Policy must be checked first'); },
  }), { code: 'INVALID_PROJECT_PATH', statusCode: 403 });
});
