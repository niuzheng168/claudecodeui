import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { discoverWorktreeDirectories } from '@/modules/worktrees/services/worktree-directories.service.js';
import { runGitCommand } from '@/modules/worktrees/services/worktree-git.service.js';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codey-directory-worktrees-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = path.join(directory, 'main');
  const linked = path.join(directory, 'linked 工作区');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (args: string[], cwd = directory) => execFileSync('git', [
    '-c', 'user.name=Directory Test', '-c', 'user.email=directory@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`,
    ...args,
  ], { cwd, env, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet', '-b', 'main', main]);
  git(['commit', '--quiet', '--allow-empty', '-m', 'fixture'], main);
  git(['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'], main);
  const denied = new Set<string>();
  const dependencies = {
    runGit: (args: string[], cwd: string) => runGitCommand(args, cwd, { readOnly: true }),
    realpath,
    validatePath: async (candidate: string) => ({
      valid: !denied.has(candidate), resolvedPath: candidate, error: 'Outside workspace',
    }),
  };
  const discover = (source: string) => discoverWorktreeDirectories(source, dependencies);
  return { directory, main, linked, denied, git, dependencies, discover };
}

test('adding either checkout discovers all other live worktrees without registering projects', async (t) => {
  const { directory, main, linked, git, discover } = await fixture(t);
  const sibling = path.join(directory, 'feature');
  git(['worktree', 'add', '--quiet', '-b', 'feature', sibling, 'HEAD'], main);
  git(['worktree', 'lock', linked], main);
  await writeFile(path.join(linked, 'dirty.txt'), 'uncommitted');
  const before = git(['worktree', 'list', '--porcelain', '-z'], main);
  assert.deepEqual((await discover(main)).paths.sort(), [linked, sibling].sort());
  assert.deepEqual((await discover(linked)).paths.sort(), [main, sibling].sort());
  assert.deepEqual((await discover(sibling)).paths.sort(), [main, linked].sort());
  assert.equal(git(['worktree', 'list', '--porcelain', '-z'], main), before);
});

test('ordinary folders, missing paths, bare repositories and repo subdirectories do not expand', async (t) => {
  const { directory, main, git, discover } = await fixture(t);
  const subdirectory = path.join(main, 'src');
  await mkdir(subdirectory);
  const bare = path.join(directory, 'bare.git');
  git(['init', '--quiet', '--bare', bare]);
  for (const candidate of [directory, subdirectory, path.join(directory, 'missing'), bare]) {
    assert.deepEqual(await discover(candidate), { paths: [] });
  }
});

test('missing, prunable and replaced worktrees are skipped independently', async (t) => {
  const { directory, main, linked, git, discover } = await fixture(t);
  const missing = path.join(directory, 'missing');
  git(['worktree', 'add', '--quiet', '--detach', missing, 'HEAD'], main);
  await rm(missing, { recursive: true });
  assert.deepEqual(await discover(main), { paths: [linked] });
  // A stale registration is not enough: this directory now belongs to another repo.
  await rm(path.join(linked, '.git'));
  git(['init', '--quiet', linked]);
  assert.deepEqual(await discover(main), { paths: [] });
});

test('workspace policy applies to both the source and discovered paths', async (t) => {
  const { main, linked, denied, dependencies, discover } = await fixture(t);
  denied.add(linked);
  assert.deepEqual(await discover(main), { paths: [] });
  denied.add(main);
  await assert.rejects(discoverWorktreeDirectories(main, {
    ...dependencies,
    runGit: async () => { throw new Error('Rejected sources must not invoke Git'); },
  }), { code: 'INVALID_PROJECT_PATH' });
});

test('invalid path inputs are rejected before filesystem or Git access', async (t) => {
  const { dependencies } = await fixture(t);
  for (const candidate of ['', 'relative/repo', '/bad\npath', '/bad\0path', ' /trimmed', '/x'.repeat(600)]) {
    await assert.rejects(discoverWorktreeDirectories(candidate, {
      ...dependencies,
      validatePath: async () => { throw new Error('Invalid inputs must not touch disk'); },
    }), { code: 'INVALID_PROJECT_PATH' });
  }
});

test('source symlinks do not add a second copy of the selected checkout', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { directory, main, linked, discover } = await fixture(t);
  const alias = path.join(directory, 'alias');
  await symlink(main, alias);
  assert.deepEqual(await discover(alias), { paths: [linked] });
});

test('worktree paths that cannot be represented in Workbench are not silently trimmed', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { directory, main, linked, git, discover } = await fixture(t);
  for (const name of ['has\nnewline', 'trailing ']) {
    git(['worktree', 'add', '--quiet', '--detach', path.join(directory, name), 'HEAD'], main);
  }
  assert.deepEqual(await discover(main), { paths: [linked] });
});
