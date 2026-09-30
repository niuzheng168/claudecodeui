import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createCodexVisualizationImageService } from '@/modules/file-tree/codex-visualization-image.service.js';
import { isPathInsideDirectory } from '@/shared/index.js';
import type { FileTreeTranscriptImageGateway } from '@/shared/index.js';

const THREAD_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF'), 0, 1, 0xff, 0xd9]);

async function fixture(t: TestContext) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(temporaryRoot, 'codey-transcript-images-')));
  t.after(async () => {
    assert.ok(isPathInsideDirectory(temporaryRoot, directory));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const home = path.join(directory, 'custom-codex-home');
  const project = path.join(directory, 'workspace');
  const threadRoot = path.join(home, 'visualizations', '2026', '09', '29', THREAD_ID);
  await mkdir(threadRoot, { recursive: true });
  await mkdir(project);
  const session = { provider: 'codex', nativeSessionId: THREAD_ID, projectPath: project };
  const lookups: string[] = [];
  const service = createCodexVisualizationImageService({
    resolveHomeDirectory: () => home,
    findSession: (id) => {
      lookups.push(id);
      return id === THREAD_ID ? session : null;
    },
  });
  const writeImage = async (name: string, bytes = PNG) => {
    const filePath = path.join(threadRoot, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    return filePath;
  };
  return { directory, home, project, threadRoot, session, service, lookups, writeImage };
}

async function readImage(
  service: FileTreeTranscriptImageGateway,
  project: string,
  file: string,
  contentType: string,
  bytes: Buffer,
) {
  const image = await service.openImage(project, file);
  assert.ok(image);
  assert.equal(image.contentType, contentType);
  const chunks: Buffer[] = [];
  for await (const chunk of image.stream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
}

test('historical and nested images in a custom Codex home stream original bytes without copying', async (t) => {
  const { service, project, writeImage, lookups } = await fixture(t);
  for (const name of ['screenshot.png', 'mobile/截图 # 1.PNG']) {
    const filePath = await writeImage(name);
    await readImage(service, project, filePath, 'image/png', PNG);
    assert.deepEqual(await readFile(filePath), PNG);
  }
  assert.deepEqual(lookups, [THREAD_ID, THREAD_ID]);
});

test('raster MIME is sniffed, including JPEG screenshots incorrectly saved with a PNG extension', async (t) => {
  const { service, project, writeImage } = await fixture(t);
  const cases = [
    ['desktop.png', JPEG, 'image/jpeg'],
    ['animation.gif', Buffer.from('GIF89a123456789'), 'image/gif'],
    ['old.gif', Buffer.from('GIF87a123456789'), 'image/gif'],
    ['render.webp', Buffer.from('RIFFxxxxWEBP123456789'), 'image/webp'],
  ] as const;
  for (const [name, bytes, type] of cases) {
    await readImage(service, project, await writeImage(name, bytes), type, bytes);
  }
});

test('Windows native and forward-slash paths retain drive and Unicode names', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { service, project, writeImage } = await fixture(t);
  const file = await writeImage('中文 screenshot.png');
  await readImage(service, project, file, 'image/png', PNG);
  await readImage(service, project.toLowerCase(), file.replace(/\\/g, '/'), 'image/png', PNG);
});

test('malformed, arbitrary, relative, traversal and non-raster paths are rejected before session lookup', async (t) => {
  const { home, project, threadRoot } = await fixture(t);
  const service = createCodexVisualizationImageService({
    resolveHomeDirectory: () => home,
    findSession: () => { throw new Error('Unrecognized paths must not probe session metadata'); },
  });
  for (const file of [
    '', 'image.png', '../image.png',
    `${threadRoot}${path.sep}nested${path.sep}..${path.sep}screenshot.png`,
    path.join(home, 'auth.json'), path.join(home, 'config.toml'),
    path.join(home, 'visualizations-other', '2026', '09', '29', THREAD_ID, 'image.png'),
    path.join(home, 'visualizations', '2026', '13', '29', THREAD_ID, 'image.png'),
    path.join(home, 'visualizations', '2026', '09', '00', THREAD_ID, 'image.png'),
    path.join(home, 'visualizations', '2026', '09', '29', 'not-a-thread', 'image.png'),
    path.join(threadRoot, 'notes.json'), path.join(threadRoot, 'screen.svg'),
    path.join(threadRoot, 'screen.png:secret.png'), `${threadRoot}${path.sep}nul\0.png`,
  ]) {
    assert.equal(await service.openImage(project, file), null, file);
  }
});

test('a path UUID is insufficient: native Codex identity and exact project ownership must match', async (t) => {
  const { home, project, threadRoot } = await fixture(t);
  const filePath = path.join(threadRoot, 'missing.png');
  // These should all fail before touching the nonexistent file.
  for (const session of [
    null,
    { provider: 'claude', nativeSessionId: THREAD_ID, projectPath: project },
    { provider: 'codex', nativeSessionId: OTHER_THREAD_ID, projectPath: project },
    { provider: 'codex', nativeSessionId: null, projectPath: project },
    { provider: 'codex', nativeSessionId: THREAD_ID, projectPath: null },
    { provider: 'codex', nativeSessionId: THREAD_ID, projectPath: 'workspace' },
    { provider: 'codex', nativeSessionId: THREAD_ID, projectPath: `${project}-other` },
    { provider: 'codex', nativeSessionId: THREAD_ID, projectPath: path.dirname(project) },
    { provider: 'codex', nativeSessionId: THREAD_ID, projectPath: path.join(project, 'nested') },
  ]) {
    const service = createCodexVisualizationImageService({
      resolveHomeDirectory: () => home,
      findSession: () => session,
    });
    assert.equal(await service.openImage(project, filePath), null);
  }
});

test('ownership is resolved on every request and never reused for another project or session', async (t) => {
  const { service, project, session, writeImage, threadRoot } = await fixture(t);
  const file = await writeImage('screenshot.png');
  await readImage(service, project, file, 'image/png', PNG);
  session.projectPath = `${project}-new`;
  assert.equal(await service.openImage(project, file), null);
  await readImage(service, session.projectPath, file, 'image/png', PNG);
  const otherFile = file.replace(THREAD_ID, OTHER_THREAD_ID);
  await mkdir(path.dirname(otherFile));
  await writeFile(otherFile, PNG);
  assert.equal(await service.openImage(session.projectPath, otherFile), null);
  assert.ok(otherFile.startsWith(path.dirname(threadRoot)));
});

test('HTML, SVG, JSON, empty or short data cannot become images by using a .png name', async (t) => {
  const { service, project, writeImage, threadRoot } = await fixture(t);
  for (const bytes of [
    Buffer.from('<html>secret</html>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    Buffer.from('{"token":"fixture-not-a-credential"}'),
    Buffer.alloc(0), Buffer.from([0xff, 0xd8]),
  ]) {
    assert.equal(await service.openImage(project, await writeImage('fake.png', bytes)), null);
  }
  const directory = path.join(threadRoot, 'directory.png');
  await mkdir(directory);
  assert.equal(await service.openImage(project, directory), null);
});

test('missing authorized images keep ENOENT for the File Tree 404 mapping', async (t) => {
  const { service, project, threadRoot } = await fixture(t);
  await assert.rejects(service.openImage(project, path.join(threadRoot, 'missing.png')), { code: 'ENOENT' });
});

test('directory symlinks or Windows junctions cannot escape a thread, including into other sessions', async (t) => {
  const { directory, service, project, threadRoot, writeImage } = await fixture(t);
  await writeImage('safe/screenshot.png');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const privateDirectory = path.join(directory, 'private');
  const otherSession = path.join(path.dirname(threadRoot), OTHER_THREAD_ID);
  await mkdir(privateDirectory);
  await mkdir(otherSession);
  for (const target of [privateDirectory, otherSession]) {
    await writeFile(path.join(target, 'screenshot.png'), PNG);
  }
  for (const [name, target] of [['escape', privateDirectory], ['other-session', otherSession]] as const) {
    const link = path.join(threadRoot, name);
    await symlink(target, link, linkType);
    assert.equal(await service.openImage(project, path.join(link, 'screenshot.png')), null);
  }
  // Links wholly inside the same verified session are not blanket-blocked.
  await symlink(path.join(threadRoot, 'safe'), path.join(threadRoot, 'inside'), linkType);
  await readImage(service, project, path.join(threadRoot, 'inside', 'screenshot.png'), 'image/png', PNG);
});

test('symlinked visualization, date and thread roots do not expand the artifact scope', async (t) => {
  const { directory, home, project, service } = await fixture(t);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const external = path.join(directory, 'external');
  await mkdir(path.join(external, THREAD_ID), { recursive: true });
  await writeFile(path.join(external, 'screenshot.png'), PNG);
  await writeFile(path.join(external, THREAD_ID, 'screenshot.png'), PNG);
  const dayLink = path.join(home, 'visualizations', '2026', '09', '30');
  await symlink(external, dayLink, linkType);
  assert.equal(await service.openImage(project, path.join(dayLink, THREAD_ID, 'screenshot.png')), null);

  const dateRoot = path.join(home, 'visualizations', '2026', '10', '01');
  await mkdir(dateRoot, { recursive: true });
  await symlink(external, path.join(dateRoot, THREAD_ID), linkType);
  assert.equal(await service.openImage(project, path.join(dateRoot, THREAD_ID, 'screenshot.png')), null);

  const alternativeHome = path.join(directory, 'other-home');
  await mkdir(alternativeHome);
  await symlink(path.join(home, 'visualizations'), path.join(alternativeHome, 'visualizations'), linkType);
  const alternativeService = createCodexVisualizationImageService({
    resolveHomeDirectory: () => alternativeHome,
    findSession: () => ({ provider: 'codex', nativeSessionId: THREAD_ID, projectPath: project }),
  });
  assert.equal(await alternativeService.openImage(
    project, path.join(alternativeHome, 'visualizations', '2026', '09', '30', THREAD_ID, 'screenshot.png'),
  ), null);
});

test('the configured Codex home may itself be a symlink without permitting escapes below it', async (t) => {
  const { directory, home, project, writeImage } = await fixture(t);
  const file = await writeImage('screenshot.png');
  const homeLink = path.join(directory, 'codex-home-link');
  await symlink(home, homeLink, process.platform === 'win32' ? 'junction' : 'dir');
  const service = createCodexVisualizationImageService({
    resolveHomeDirectory: () => homeLink,
    findSession: () => ({ provider: 'codex', nativeSessionId: THREAD_ID, projectPath: project }),
  });
  await readImage(service, project, path.join(homeLink, path.relative(home, file)), 'image/png', PNG);
});
