import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readProjectRepository } from '@/modules/projects/services/project-repository.service.js';

/** Lays out the files Git writes for a main checkout, a linked worktree and a submodule. */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-repository-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'codey');
  await fs.mkdir(path.join(main, '.git', 'worktrees', 'keen'), { recursive: true });
  await fs.writeFile(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.mkdir(path.join(main, 'src'), { recursive: true });

  const worktree = path.join(main, '.claude', 'worktrees', 'keen');
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'keen')}\n`);
  await fs.writeFile(path.join(main, '.git', 'worktrees', 'keen', 'commondir'), '../..\n');
  await fs.writeFile(path.join(main, '.git', 'worktrees', 'keen', 'HEAD'), 'ref: refs/heads/claude/keen\n');

  const detached = path.join(root, '.codex', 'worktrees', 'ba46', 'codey');
  await fs.mkdir(path.join(main, '.git', 'worktrees', 'codey'), { recursive: true });
  await fs.mkdir(detached, { recursive: true });
  await fs.writeFile(path.join(detached, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'codey')}\n`);
  await fs.writeFile(path.join(main, '.git', 'worktrees', 'codey', 'commondir'), '../..\n');
  await fs.writeFile(path.join(main, '.git', 'worktrees', 'codey', 'HEAD'), '4f1c2a9d0e6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d\n');

  const submodule = path.join(main, 'cloudcli');
  await fs.mkdir(path.join(main, '.git', 'modules', 'cloudcli'), { recursive: true });
  await fs.mkdir(submodule, { recursive: true });
  await fs.writeFile(path.join(submodule, '.git'), 'gitdir: ../.git/modules/cloudcli\n');
  await fs.writeFile(path.join(main, '.git', 'modules', 'cloudcli', 'HEAD'), 'ref: refs/heads/main\n');
  return { root, main, worktree, detached, submodule };
}

test('a main checkout is its own root and reports its branch', async (t) => {
  const { main } = await fixture(t);
  assert.deepEqual(await readProjectRepository(main), { root: main, checkout: main, worktree: false, branch: 'main' });
});

test('a directory inside a checkout reports the checkout it belongs to', async (t) => {
  const { main } = await fixture(t);
  const result = await readProjectRepository(path.join(main, 'src'));
  assert.equal(result?.root, main);
  assert.equal(result?.worktree, false);
});

test('a linked worktree points back at the main checkout it was added from', async (t) => {
  const { main, worktree } = await fixture(t);
  assert.deepEqual(await readProjectRepository(worktree), {
    root: main, checkout: worktree, worktree: true, branch: 'claude/keen',
  });
});

test('a worktree outside the repository (Codex Desktop) still finds its main checkout', async (t) => {
  const { main, detached } = await fixture(t);
  assert.deepEqual(await readProjectRepository(detached), {
    root: main, checkout: detached, worktree: true, branch: null,
  });
});

test('a submodule is a checkout of its own, not a worktree', async (t) => {
  const { submodule } = await fixture(t);
  assert.deepEqual(await readProjectRepository(submodule), {
    root: submodule, checkout: submodule, worktree: false, branch: 'main',
  });
});

test('a removed worktree and a directory outside any repository report nothing', async (t) => {
  const { root, main } = await fixture(t);
  assert.equal(await readProjectRepository(path.join(main, '.claude', 'worktrees', 'gone')), null);
  const plain = path.join(root, 'plain');
  await fs.mkdir(plain);
  // The temp root's parents are not repositories on a normal test machine.
  const result = await readProjectRepository(plain);
  assert.ok(result === null || !result.checkout.startsWith(root));
});
