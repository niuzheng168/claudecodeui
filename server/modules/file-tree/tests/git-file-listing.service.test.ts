import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { listGitFiles } from '@/modules/file-tree/git-file-listing.service.js';

async function createRepositoryFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codey-git-file-listing-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repository');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (args: string[], cwd = repository) => execFileSync('git', [
    '-c', 'user.name=File Listing Test',
    '-c', 'user.email=file-listing@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`,
    '-c', 'protocol.file.allow=always',
    ...args,
  ], { cwd, env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet', '-b', 'main', repository], directory);
  const write = async (relativePath: string, content = 'fixture') => {
    await mkdir(path.dirname(path.join(repository, relativePath)), { recursive: true });
    await writeFile(path.join(repository, relativePath), content);
  };
  return { directory, repository, git, write };
}

const sorted = (paths: string[]) => [...paths].sort();

test('git lists tracked files and untracked ones it does not ignore, relative to the project folder', async (t) => {
  const { repository, git, write } = await createRepositoryFixture(t);
  await write('.gitignore', '*.log\nbuild/\n');
  await write('README.md');
  await write('src/app/main.ts');
  await write('src/app/kept.log');
  git(['add', '.gitignore', 'README.md', 'src']);
  git(['add', '--force', 'src/app/kept.log']);
  git(['commit', '--quiet', '-m', 'fixture']);
  await write('src/app/new file.ts');
  await write('src/app/debug.log');
  await write('build/output.js');

  const listed = await listGitFiles(repository, 100);
  assert.deepEqual(listed && { ...listed, paths: sorted(listed.paths) }, {
    paths: ['.gitignore', 'README.md', 'src/app/kept.log', 'src/app/main.ts', 'src/app/new file.ts'],
    truncated: false,
  });

  const fromFolder = await listGitFiles(path.join(repository, 'src'), 100);
  assert.deepEqual(fromFolder && sorted(fromFolder.paths), ['app/kept.log', 'app/main.ts', 'app/new file.ts']);
});

test('git lists the files of checked-out submodules', async (t) => {
  const { directory, repository, git, write } = await createRepositoryFixture(t);
  const library = path.join(directory, 'library');
  git(['init', '--quiet', '-b', 'main', library], directory);
  await writeFile(path.join(library, 'lib.ts'), 'fixture');
  git(['add', 'lib.ts'], library);
  git(['commit', '--quiet', '-m', 'library'], library);
  await write('app.ts');
  git(['add', 'app.ts']);
  git(['submodule', '--quiet', 'add', library, 'vendor/library']);
  git(['commit', '--quiet', '-m', 'fixture']);

  const listed = await listGitFiles(repository, 100);
  assert.deepEqual(listed && sorted(listed.paths), ['.gitmodules', 'app.ts', 'vendor/library/lib.ts']);
});

test('git lists a file with a merge conflict once', async (t) => {
  const { repository, git, write } = await createRepositoryFixture(t);
  await write('shared.ts', 'base');
  git(['add', 'shared.ts']);
  git(['commit', '--quiet', '-m', 'base']);
  git(['checkout', '--quiet', '-b', 'other']);
  await write('shared.ts', 'other');
  git(['commit', '--quiet', '-am', 'other']);
  git(['checkout', '--quiet', 'main']);
  await write('shared.ts', 'main');
  git(['commit', '--quiet', '-am', 'main']);
  assert.throws(() => git(['merge', '--quiet', 'other']));
  assert.match(git(['ls-files', '--cached']), /^shared\.ts\nshared\.ts\n/);

  assert.deepEqual(await listGitFiles(repository, 100), { paths: ['shared.ts'], truncated: false });
});

test('git stops at the file limit, and a folder outside any repository is not listed', async (t) => {
  const { directory, repository, git, write } = await createRepositoryFixture(t);
  for (const name of ['a.ts', 'b.ts', 'c.ts']) await write(name);
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'fixture']);
  await write('d.ts');

  assert.deepEqual(await listGitFiles(repository, 2), { paths: ['a.ts', 'b.ts'], truncated: true });
  const listed = await listGitFiles(repository, 4);
  assert.deepEqual(listed && { ...listed, paths: sorted(listed.paths) }, { paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], truncated: false });

  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  assert.equal(await listGitFiles(outside, 100), null);
});
