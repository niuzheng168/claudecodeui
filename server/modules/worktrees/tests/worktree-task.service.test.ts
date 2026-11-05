import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '@/shared/utils.js';
import { createTaskWorktree } from '@/modules/worktrees/services/worktree-task.service.js';
import type { CreateWorktreeInput } from '@/shared/types.js';

const porcelain = 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-worktrees/codey-wi-7\nHEAD def\nbranch refs/heads/codey/wi-7\n';

function harness({ originHead = 'origin/main', localBranches = [] as string[], fetchFails = false, folderTaken = [] as string[] } = {}) {
  const git: string[][] = [];
  const created: CreateWorktreeInput[] = [];
  let fetched = 0;
  const dependencies = {
    runGit: async (args: string[]) => {
      git.push(args);
      if (args[0] === 'worktree') return { stdout: porcelain, stderr: '' };
      if (args[0] === 'symbolic-ref') {
        if (!originHead) throw new AppError('no origin head', { code: 'GIT_COMMAND_FAILED' });
        return { stdout: `${originHead}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)!;
        if (ref === 'refs/remotes/origin/master' || localBranches.some(branch => ref === `refs/heads/${branch}`)) return { stdout: 'x', stderr: '' };
        throw new AppError('missing', { code: 'GIT_COMMAND_FAILED' });
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    fetchOrigin: async () => { fetched++; if (fetchFails) throw new Error('offline'); },
    createAndOpen: async (input: CreateWorktreeInput) => {
      created.push(input);
      if (folderTaken.includes(input.branch)) throw new AppError('exists', { code: 'WORKTREE_FOLDER_EXISTS', statusCode: 409 });
      return { worktreePath: `/repo-worktrees/${input.branch.replace(/\//g, '-')}`, branch: input.branch, createdBranch: true, project: {} as never };
    },
  };
  return { dependencies, git, created, fetched: () => fetched };
}

test('a task worktree branches from the fetched remote default branch at the repository root', async () => {
  const h = harness();
  const result = await createTaskWorktree({ projectPath: '/repo/sub', branch: 'codey/wi-8' }, h.dependencies);
  assert.equal(h.fetched(), 1);
  assert.deepEqual(h.created, [{ projectPath: '/repo', branch: 'codey/wi-8', baseBranch: 'origin/main' }]);
  assert.equal(result.branch, 'codey/wi-8');
});

test('names already used get a suffix instead of reusing an earlier attempt; fetch failures do not block', async () => {
  const h = harness({ originHead: '', localBranches: ['codey/wi-7-2'], fetchFails: true, folderTaken: ['codey/wi-7-3'] });
  const result = await createTaskWorktree({ projectPath: '/repo', branch: 'codey/wi-7' }, h.dependencies);
  assert.equal(result.branch, 'codey/wi-7-4');
  assert.deepEqual(h.created.map(input => [input.branch, input.baseBranch]), [['codey/wi-7-3', 'origin/master'], ['codey/wi-7-4', 'origin/master']]);
});

test('a directory outside Git and an invalid branch are refused before any change', async () => {
  const h = harness();
  await assert.rejects(createTaskWorktree({ projectPath: '/repo', branch: '../escape' }, h.dependencies), { code: 'INVALID_BRANCH_NAME' });
  const notGit = { ...h.dependencies, runGit: async () => { throw new AppError('not git', { code: 'GIT_COMMAND_FAILED' }); } };
  await assert.rejects(createTaskWorktree({ projectPath: '/tmp', branch: 'codey/wi-1' }, notGit), { code: 'SESSION_START_NOT_GIT' });
  assert.equal(h.created.length, 0);
});
