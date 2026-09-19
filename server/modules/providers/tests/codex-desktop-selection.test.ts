import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { assertCodexDesktopSelection } from '@/modules/providers/list/codex/codex-thread-storage.repository.js';

test('native queue never silently changes the desktop model or widens explicit permission restrictions', async () => {
  const parent = path.resolve(os.tmpdir());
  const home = await mkdtemp(path.join(parent, 'codey-desktop-policy-'));
  const before = process.env.CODEX_HOME;
  const database = new Database(path.join(home, 'state_5.sqlite'));
  try {
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, reasoning_effort TEXT, sandbox_policy TEXT, approval_mode TEXT)');
    database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(
      'desktop', 'desktop-model', 'max', '{"type":"disabled"}', 'never',
    );
    process.env.CODEX_HOME = home;
    await assertCodexDesktopSelection('desktop', {});
    await assertCodexDesktopSelection('desktop', { model: 'desktop-model', effort: 'max', permissionMode: 'bypassPermissions' });
    for (const options of [{ model: 'different-model' }, { effort: 'low' }, { permissionMode: 'default' }, { permissionMode: 'acceptEdits' }]) {
      await assert.rejects(assertCodexDesktopSelection('desktop', options), { code: 'CODEX_DESKTOP_SETTINGS_MISMATCH' });
    }
    assert.deepEqual(database.prepare('SELECT model, reasoning_effort, sandbox_policy, approval_mode FROM threads').get(), {
      model: 'desktop-model', reasoning_effort: 'max', sandbox_policy: '{"type":"disabled"}', approval_mode: 'never',
    });
    database.prepare('UPDATE threads SET sandbox_policy=?, approval_mode=? WHERE id=?').run(
      '{"type":"workspace-write","writable_roots":[],"network_access":false}', 'untrusted', 'desktop',
    );
    await assertCodexDesktopSelection('desktop', { permissionMode: 'default', cwd: home });
    if (process.platform !== 'win32') {
      database.prepare('UPDATE threads SET sandbox_policy=? WHERE id=?').run(
        JSON.stringify({ type: 'workspace-write', writable_roots: [path.join(home, 'Workspace')], network_access: false }),
        'desktop',
      );
      await assertCodexDesktopSelection('desktop', { permissionMode: 'default', cwd: path.join(home, 'Workspace') });
      await assert.rejects(assertCodexDesktopSelection('desktop', {
        permissionMode: 'default', cwd: path.join(home, 'workspace'),
      }), { code: 'CODEX_DESKTOP_SETTINGS_MISMATCH' });
    }
  } finally {
    database.close();
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
    assert.equal(path.dirname(path.resolve(home)), parent);
    assert.ok(path.basename(home).startsWith('codey-desktop-policy-'));
    await rm(home, { recursive: true, force: true });
  }
});
