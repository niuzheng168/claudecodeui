import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { readRunningPackage } from '../runtime-health.service.js';

function fixture(pkg: unknown, build: unknown = null) {
  const calls: string[] = [];
  const files = new Map([
    ['package.json', JSON.stringify(pkg)],
    ['codey-build.json', JSON.stringify(build)],
  ]);
  const read = (filename: string) => {
    calls.push(filename);
    const value = files.get(path.basename(filename));
    if (value === undefined) throw new Error('private filesystem detail');
    return value;
  };
  return { files, calls, read };
}

const build = {
  schema: 1, name: 'codey', version: '0.1.18', sourceDirty: false,
  sourceCommit: 'a'.repeat(40), secret: 'MUST_NOT_BE_EXPOSED',
};

test('running Codey identity comes from the actual package and build, not an updater or environment label', () => {
  const f = fixture({ name: 'codey', version: '0.1.18', privateData: 'MUST_NOT_BE_EXPOSED' }, build);
  const identity = readRunningPackage('/application', { read: f.read, nodeVersion: '24.20.0' });
  assert.deepEqual(identity, {
    version: '0.1.18',
    codey: {
      name: 'codey', version: '0.1.18', commit: build.sourceCommit, nodeMajor: 24,
      releaseId: 'machine-' + createHash('sha256').update(JSON.stringify(build)).digest('hex').slice(0, 16),
    },
  });
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(identity), /MUST_NOT_BE_EXPOSED|application|updater|privateData/);
  f.files.set('package.json', JSON.stringify({ name: 'codey', version: '0.1.19' }));
  f.files.set('codey-build.json', JSON.stringify({ ...build, version: '0.1.19' }));
  assert.equal(identity.codey?.version, '0.1.18', 'Staging new files must not pretend the old process restarted');
  assert.equal(f.calls.length, 2, 'Responses reuse a startup snapshot');
  assert(Object.isFrozen(identity) && Object.isFrozen(identity.codey));
});

test('managed standalone Workspace versions never become Codey package versions', () => {
  for (const name of ['@cloudcli-ai/cloudcli', 'claude-code-ui', undefined]) {
    const f = fixture({ name, version: '1.37.2' }, build);
    assert.deepEqual(readRunningPackage('/application', { read: f.read }),
      { version: '1.37.2', codey: null });
    assert.equal(f.calls.length, 1);
  }
});

test('malformed, missing, mismatched or uncommitted build identities fail closed without leaking files', () => {
  for (const changed of [
    null, { ...build, schema: 2 }, { ...build, name: 'other' }, { ...build, version: '0.1.16' },
    { ...build, sourceDirty: true }, { ...build, sourceCommit: 'not-a-commit' },
  ]) {
    const f = fixture({ name: 'codey', version: '0.1.18' }, changed);
    assert.deepEqual(readRunningPackage('/application', { read: f.read }),
      { version: '0.1.18', codey: null });
  }
  const missing = fixture({ name: 'codey', version: '0.1.18' });
  missing.files.delete('codey-build.json');
  assert.equal(readRunningPackage('/application', { read: missing.read }).codey, null);
  for (const text of ['{invalid', ' '.repeat(65 * 1024)]) {
    const f = fixture(null); f.files.set('package.json', text);
    assert.deepEqual(readRunningPackage('/application', { read: f.read }), { version: null, codey: null });
  }
  const invalid = fixture({ name: 'codey', version: '<script>secret</script>' }, build);
  assert.deepEqual(readRunningPackage('/application', { read: invalid.read }), { version: null, codey: null });
  const badNode = fixture({ name: 'codey', version: '0.1.18' }, build);
  assert.equal(readRunningPackage('/application', { read: badNode.read, nodeVersion: 'invalid' }).codey, null);
});
