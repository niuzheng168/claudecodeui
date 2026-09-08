import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Node's test runner isolates this file. Configure the shared module before its
// first import, then restore the environment so no subprocess inherits the override.
const driveRoot = path.parse(await realpath(os.tmpdir())).root;
const previousRoot = process.env.WORKSPACES_ROOT;
process.env.WORKSPACES_ROOT = driveRoot;
const { validateWorkspacePath } = await import('@/shared/index.js');
if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
else process.env.WORKSPACES_ROOT = previousRoot;

test('a configured filesystem root accepts its existing and not-yet-created child workspaces', async (t) => {
  const prefix = 'cloudcli-workspace-root-';
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith(prefix));
    await rm(folder, { recursive: true, force: true });
  });
  assert.equal((await validateWorkspacePath(folder)).valid, true);
  assert.equal((await validateWorkspacePath(path.join(folder, 'new-project'))).valid, true);
});

test('root containment still rejects a different Windows drive or critical POSIX directory', async () => {
  const outside = process.platform === 'win32'
    ? `${driveRoot[0].toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\cloudcli-outside-root`
    : '/etc';
  const result = await validateWorkspacePath(outside);
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /outside|within|system/i);
});
