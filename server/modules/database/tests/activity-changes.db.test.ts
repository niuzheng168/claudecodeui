import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { activityChangesDb } from '@/modules/database/repositories/activity-changes.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'activity-changes-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const pending = () => activityChangesDb.pending(10).map((item) => `${item.sessionId} ${item.provider} ${item.change} ${item.revision}`);

test('every archive, restore and deletion of a Claude or Codex session waits for the Portal, latest only', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('c-1', 'claude', '/repo');
    sessionsDb.createSession('x-1', 'codex', '/repo');
    sessionsDb.createSession('g-1', 'gemini', '/repo');
    activityChangesDb.initialize();
    assert.deepEqual(pending(), [], 'sessions as they were are no news');

    sessionsDb.updateSessionIsArchived('c-1', true);
    sessionsDb.updateSessionIsArchived('c-1', true);
    sessionsDb.updateSessionIsArchived('g-1', true);
    assert.deepEqual(pending(), ['c-1 claude archived 1'], 'only a real change, and only the providers the Portal shows');
    sessionsDb.updateSessionIsArchived('c-1', false);
    sessionsDb.deleteSessionById('x-1');
    sessionsDb.deleteSessionById('g-1');
    assert.deepEqual(pending(), ['c-1 claude restored 2', 'x-1 codex deleted 1']);

    activityChangesDb.acknowledge([{ sessionId: 'c-1', revision: 1 }, { sessionId: 'x-1', revision: 1 }]);
    assert.deepEqual(pending(), ['c-1 claude restored 2'], 'a newer change is not acknowledged by an older report');
    activityChangesDb.acknowledge([{ sessionId: 'c-1', revision: 2 }]);
    assert.deepEqual(pending(), []);
  });
});

test('a session deleted and written again before the Portal heard is reported as it is now', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('c-1', 'claude', '/repo');
    activityChangesDb.initialize();
    sessionsDb.deleteSessionById('c-1');
    sessionsDb.createSession('c-1', 'claude', '/repo');
    assert.deepEqual(pending(), ['c-1 claude restored 2']);
  });
});

test('the triggers come back after a migration rebuilds the sessions table and the node starts again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('c-1', 'claude', '/repo');
    activityChangesDb.initialize();
    getConnection().exec('DROP TRIGGER activity_session_archive');
    closeConnection();
    activityChangesDb.initialize();
    sessionsDb.updateSessionIsArchived('c-1', true);
    assert.deepEqual(pending(), ['c-1 claude archived 1']);
  });
});
