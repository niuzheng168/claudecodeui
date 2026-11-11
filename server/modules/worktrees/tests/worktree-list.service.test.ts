import assert from 'node:assert/strict';
import test from 'node:test';

import { listWorktrees } from '@/modules/worktrees/services/worktree-list.service.js';
import type { GitCommandResult } from '@/shared/types.js';

test('listWorktrees bounds concurrent per-worktree Git inspection and preserves ordering', async () => {
  const entryCount = 10;
  const porcelain = Array.from({ length: entryCount }, (_, index) => [
    `worktree /workspace/repo-${index}`,
    `HEAD ${String(index).padStart(40, '0')}`,
    `branch refs/heads/${index === 0 ? 'main' : `feature/${index}`}`,
    '',
  ].join('\n')).join('\n');
  let activeCommands = 0;
  let maximumActiveCommands = 0;

  const runGit = async (args: string[]): Promise<GitCommandResult> => {
    if (args[0] === 'worktree') {
      return { stdout: porcelain, stderr: '' };
    }

    activeCommands += 1;
    maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeCommands -= 1;

    if (args[0] === 'log') {
      return { stdout: 'subject\0' + '2026-01-01T00:00:00Z', stderr: '' };
    }
    if (args[0] === 'rev-list') {
      return { stdout: '0 1', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const result = await listWorktrees(
    { projectPath: '/workspace/repo-0' },
    { runGit, getProjectByPath: () => null },
  );

  assert.equal(maximumActiveCommands <= 12, true);
  assert.deepEqual(result.worktrees.map((worktree) => worktree.path.replace(/\\/g, '/')),
    Array.from({ length: entryCount }, (_, index) => `/workspace/repo-${index}`));
});

test('listWorktrees leaves out a worktree whose directory is gone instead of failing', async () => {
  const porcelain = [
    'worktree /workspace/repo', `HEAD ${'1'.repeat(40)}`, 'branch refs/heads/main', '',
    'worktree /tmp/review/worktree', `HEAD ${'2'.repeat(40)}`, 'detached',
    'prunable gitdir file points to non-existent location', '',
    'worktree /workspace/repo-feature', `HEAD ${'3'.repeat(40)}`, 'branch refs/heads/feature', '',
  ].join('\n');
  const inspected = new Set<string>();

  const runGit = async (args: string[], cwd: string): Promise<GitCommandResult> => {
    if (args[0] === 'worktree') {
      return { stdout: porcelain, stderr: '' };
    }
    inspected.add(cwd.replace(/\\/g, '/'));
    // Spawning git in a directory that does not exist fails as if git were missing.
    if (cwd.replace(/\\/g, '/') === '/tmp/review/worktree') {
      throw new Error('Failed to run git: spawn git ENOENT');
    }
    return { stdout: args[0] === 'rev-list' ? '0 0' : '', stderr: '' };
  };

  const result = await listWorktrees(
    { projectPath: '/workspace/repo' },
    { runGit, getProjectByPath: () => null },
  );

  assert.deepEqual(result.worktrees.map((worktree) => worktree.path.replace(/\\/g, '/')),
    ['/workspace/repo', '/workspace/repo-feature']);
  assert.equal(inspected.has('/tmp/review/worktree'), false);
});
