import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { findRelatedWorktreeFileRoot } from '@/modules/worktrees/services/worktree-file-scope.service.js';
import { runGitCommand } from '@/modules/worktrees/services/worktree-git.service.js';
import type { GitCommandRunner } from '@/shared/index.js';

const runReadOnlyGit: GitCommandRunner = (args, cwd) => runGitCommand(args, cwd, { readOnly: true });

async function createRepositoryFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codey-file-worktrees-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const main = path.join(directory, 'main');
  const linked = path.join(directory, 'linked worktree');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (args: string[], cwd = directory) => execFileSync('git', [
    '-c', 'user.name=File Scope Test',
    '-c', 'user.email=file-scope@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`,
    ...args,
  ], { cwd, env, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet', '-b', 'main', main]);
  await mkdir(path.join(main, 'src'));
  await writeFile(path.join(main, 'src', 'design.md'), '# fixture design');
  await writeFile(path.join(main, 'outside-src.txt'), 'fixture, not private data');
  git(['add', '.'], main);
  git(['commit', '--quiet', '-m', 'fixture'], main);
  git(['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'], main);
  const resolve = (project: string, file: string) => findRelatedWorktreeFileRoot(project, file, {
    runGit: runReadOnlyGit, realpath,
  });
  return { directory, main, linked, git, resolve };
}

test('a real repository permits main-to-worktree, worktree-to-main and sibling file links', async (t) => {
  const { directory, main, linked, git, resolve } = await createRepositoryFixture(t);
  const sibling = path.join(directory, 'another checkout');
  git(['worktree', 'add', '--quiet', '--detach', sibling, 'HEAD'], main);

  assert.equal(await resolve(main, path.join(linked, 'src', 'design.md')), linked);
  assert.equal(await resolve(linked, path.join(main, 'src', 'design.md')), main);
  assert.equal(await resolve(linked, path.join(sibling, 'src', 'design.md')), sibling);
  // Resolving a permitted scope must not require the file to exist yet.
  assert.equal(await resolve(main, path.join(linked, 'src', 'new.md')), linked);
});

test('a subdirectory project grants only the corresponding directory in another checkout', async (t) => {
  const { main, linked, resolve } = await createRepositoryFixture(t);
  const project = path.join(main, 'src');
  assert.equal(
    await resolve(project, path.join(linked, 'src', 'design.md')),
    path.join(linked, 'src'),
  );
  for (const target of [
    path.join(linked, 'outside-src.txt'),
    path.join(linked, 'src-other', 'private.txt'),
    path.join(linked, 'src'),
    path.join(linked, 'src', '..', 'outside-src.txt'),
  ]) {
    assert.equal(await resolve(project, target), null);
  }
});

test('unlisted repositories and prefix siblings are denied without running Git in the target', async (t) => {
  const { directory, main, linked, git } = await createRepositoryFixture(t);
  const unrelated = path.join(directory, 'unrelated');
  git(['init', '--quiet', unrelated]);
  const queriedDirectories: string[] = [];
  for (const target of [
    path.join(unrelated, 'file.md'),
    path.join(`${linked}-other`, 'file.md'),
    path.join(directory, 'home-file.md'),
  ]) {
    assert.equal(await findRelatedWorktreeFileRoot(main, target, {
      realpath,
      runGit: async (args, cwd) => {
        queriedDirectories.push(cwd);
        return runReadOnlyGit(args, cwd);
      },
    }), null);
  }
  assert.ok(queriedDirectories.length > 0);
  assert.ok(queriedDirectories.every((cwd) => cwd === main));
});

test('non-Git projects and failed queries do not expand the file boundary', async (t) => {
  const { directory, main, linked, resolve } = await createRepositoryFixture(t);
  assert.equal(await resolve(directory, path.join(linked, 'src', 'design.md')), null);
  assert.equal(await findRelatedWorktreeFileRoot(main, path.join(linked, 'doc.md'), {
    realpath,
    runGit: async () => { throw new Error('Git unavailable or timed out'); },
  }), null);
  assert.equal(await findRelatedWorktreeFileRoot(main, '../linked/doc.md', {
    realpath: async () => { throw new Error('relative traversal must not touch disk'); },
    runGit: async () => { throw new Error('relative traversal must not invoke Git'); },
  }), null);
});

test('a stale worktree directory replaced with a different repository is denied', async (t) => {
  const { main, linked, git, resolve } = await createRepositoryFixture(t);
  await rm(path.join(linked, '.git'));
  git(['init', '--quiet', linked]);
  assert.equal(await resolve(main, path.join(linked, 'src', 'design.md')), null);
});

test('missing/prunable worktrees are denied', async (t) => {
  const { main, linked, resolve } = await createRepositoryFixture(t);
  await rm(linked, { recursive: true });
  assert.equal(await resolve(main, path.join(linked, 'src', 'design.md')), null);
});

test('a worktree subdirectory symlink cannot extend a narrow project outside that checkout', {
  skip: process.platform === 'win32' ? 'Creating directory symlinks requires Windows privileges' : false,
}, async (t) => {
  const { directory, main, linked, resolve } = await createRepositoryFixture(t);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'design.md'), 'outside fixture');
  await rm(path.join(linked, 'src'), { recursive: true });
  await symlink(outside, path.join(linked, 'src'));
  assert.equal(await resolve(path.join(main, 'src'), path.join(linked, 'src', 'design.md')), null);
});

test('worktree discovery preserves Unicode, newlines and trailing spaces in paths', {
  skip: process.platform === 'win32' ? 'Windows filenames do not allow these characters' : false,
}, async (t) => {
  const { directory, main, git, resolve } = await createRepositoryFixture(t);
  const unusual = path.join(directory, 'design 工作区\ntrailing ');
  git(['worktree', 'add', '--quiet', '--detach', unusual, 'HEAD'], main);
  assert.equal(await resolve(main, path.join(unusual, 'src', 'design.md')), unusual);
  assert.equal(await resolve(unusual, path.join(main, 'src', 'design.md')), main);
});

test('inherited Git repository/config overrides cannot redirect read-only scope discovery', async (t) => {
  const { directory, main, linked, git, resolve } = await createRepositoryFixture(t);
  const unrelated = path.join(directory, 'ambient-repo');
  git(['init', '--quiet', unrelated]);
  const overrides = {
    GIT_DIR: path.join(unrelated, '.git'),
    GIT_COMMON_DIR: path.join(unrelated, '.git'),
    GIT_WORK_TREE: unrelated,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    assert.equal(await resolve(main, path.join(linked, 'src', 'design.md')), linked);
    assert.equal(await resolve(main, path.join(unrelated, 'private.md')), null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('read-only Git queries cap subprocess output', async (t) => {
  const { directory, main } = await createRepositoryFixture(t);
  const configFile = path.join(directory, 'large-config');
  await writeFile(configFile, `[fixture]\nvalue = ${'x'.repeat(1024 * 1024 + 1)}\n`);
  await assert.rejects(
    runReadOnlyGit(['config', '--file', configFile, '--get', 'fixture.value'], main),
    { code: 'GIT_OUTPUT_TOO_LARGE' },
  );
});
