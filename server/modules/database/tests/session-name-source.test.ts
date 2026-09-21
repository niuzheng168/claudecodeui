import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

async function withDatabase(run: () => void): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-name-source-'));
  const previousDatabase = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    // Never bootstrap these tests from an operator's legacy auth database.
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    run();
  } finally {
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    await rm(root, { recursive: true, force: true });
  }
}

test('Codex app-generated names follow native names without changing app/provider identity', async () => {
  await withDatabase(() => {
    sessionsDb.createAppSession('app-id', 'codex', '/workspace/demo', 'First prompt');
    sessionsDb.assignProviderSessionId('app-id', 'native-id');
    assert.equal(sessionsDb.createSession('native-id', 'codex', '/workspace/demo', 'Native title'), 'app-id');
    assert.equal(sessionsDb.getSessionById('app-id')?.custom_name, 'Native title');
    assert.equal(sessionsDb.getSessionById('app-id')?.custom_name_source, 'auto');
    assert.equal(sessionsDb.getSessionById('native-id'), null);
  });
});

test('both upsert paths protect explicit local names, including the old default-title string', async () => {
  await withDatabase(() => {
    for (const id of ['mapped', 'legacy']) {
      sessionsDb.createSession(id, 'codex', '/workspace/demo', 'Imported');
      sessionsDb.updateSessionCustomName(id, 'Untitled Codex Session');
    }
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run('legacy');
    for (const id of ['mapped', 'legacy']) {
      sessionsDb.createSession(id, 'codex', '/workspace/demo', 'Native rename');
      assert.equal(sessionsDb.getSessionById(id)?.custom_name, 'Untitled Codex Session');
      assert.equal(sessionsDb.getSessionById(id)?.custom_name_source, 'user');
      assert.equal(sessionsDb.updateSessionSyncedName(id, 'Late sync'), false);
    }
  });
});

test('metadata-only title refresh leaves recency and archives unchanged', async () => {
  await withDatabase(() => {
    const timestamp = '2026-09-18T08:07:49.000Z';
    sessionsDb.createSession('native', 'codex', '/workspace/demo', 'Before', timestamp, timestamp);
    assert.equal(sessionsDb.updateSessionSyncedName('native', 'After'), true);
    assert.equal(sessionsDb.updateSessionSyncedName('native', 'After'), false);
    assert.equal(sessionsDb.getSessionById('native')?.updated_at, timestamp);
    sessionsDb.updateSessionIsArchived('native', true);
    assert.equal(sessionsDb.updateSessionSyncedName('native', 'Archived change'), false);
    assert.equal(sessionsDb.getSessionById('native')?.custom_name, 'After');
    assert.equal(sessionsDb.getSessionById('native')?.isArchived, 1);
    sessionsDb.createAppSession('claude-app', 'claude', '/workspace/demo', 'Claude app name');
    assert.equal(sessionsDb.updateSessionSyncedName('claude-app', 'Disk name'), false);
  });
});

test('a generated title cannot update a session that moved to another native thread', async () => {
  await withDatabase(() => {
    sessionsDb.createAppSession('app', 'codex', '/workspace/demo', 'Initial title');
    sessionsDb.assignProviderSessionId('app', 'new-native');
    assert.equal(sessionsDb.updateSessionSyncedName('app', 'Old generated title', 'old-native'), false);
    assert.equal(sessionsDb.getSessionById('app')?.custom_name, 'Initial title');
    assert.equal(sessionsDb.updateSessionSyncedName('app', 'Current generated title', 'new-native'), true);
    sessionsDb.updateSessionCustomName('app', 'Manual title');
    assert.equal(sessionsDb.updateSessionSyncedName('app', 'Late generated title', 'new-native'), false);
    assert.equal(sessionsDb.getSessionById('app')?.custom_name, 'Manual title');
  });
});
test('old Codex titles are backed up once before automatic names are refreshed', async () => {
  await withDatabase(() => {
    sessionsDb.createSession('legacy-codex', 'codex', '/workspace/demo', 'Legacy cached title');
    sessionsDb.createSession('legacy-claude', 'claude', '/workspace/demo', 'Claude title');
    const db = getConnection();
    db.exec('ALTER TABLE sessions DROP COLUMN custom_name_source');
    db.exec('ALTER TABLE sessions DROP COLUMN legacy_custom_name');
    runMigrations(db);

    assert.equal(sessionsDb.getSessionById('legacy-codex')?.legacy_custom_name, 'Legacy cached title');
    assert.equal(sessionsDb.getSessionById('legacy-codex')?.custom_name_source, 'auto');
    assert.equal(sessionsDb.getSessionById('legacy-claude')?.legacy_custom_name, null);
    sessionsDb.createSession('legacy-codex', 'codex', '/workspace/demo', 'Current native title');
    assert.equal(sessionsDb.getSessionById('legacy-codex')?.custom_name, 'Current native title');
    sessionsDb.updateSessionCustomName('legacy-codex', 'Explicit local name');
    runMigrations(db);
    assert.equal(sessionsDb.getSessionById('legacy-codex')?.custom_name, 'Explicit local name');
    assert.equal(sessionsDb.getSessionById('legacy-codex')?.custom_name_source, 'user');
    assert.equal(sessionsDb.getSessionById('legacy-codex')?.legacy_custom_name, 'Legacy cached title');
  });
});

test('merging a discovered duplicate carries manual-name provenance and preserves the app override', async () => {
  await withDatabase(() => {
    for (const manualApp of [false, true]) {
      const appId = `app-${manualApp}`;
      const nativeId = `native-${manualApp}`;
      sessionsDb.createAppSession(appId, 'codex', '/workspace/demo', 'Initial prompt');
      if (manualApp) sessionsDb.updateSessionCustomName(appId, 'App manual name');
      sessionsDb.createSession(nativeId, 'codex', '/workspace/demo', 'Imported');
      sessionsDb.updateSessionCustomName(nativeId, 'Duplicate manual name');
      sessionsDb.assignProviderSessionId(appId, nativeId);
      sessionsDb.createSession(nativeId, 'codex', '/workspace/demo', 'Native rename');
      assert.equal(sessionsDb.getSessionById(appId)?.custom_name_source, 'user');
      assert.equal(sessionsDb.getSessionById(appId)?.custom_name,
        manualApp ? 'App manual name' : 'Duplicate manual name');
      assert.equal(sessionsDb.getSessionById(nativeId), null);
    }
  });
});
