import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  CodexSessionSynchronizer,
  synchronizeCodexSessionIndex,
} from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';

const THREAD_ID = 'title-regression-thread';
const ENVIRONMENT_KEYS = [
  'DATABASE_PATH', 'CODEX_HOME', 'CODEY_CODEX_EXECUTABLE',
  'CODEY_CODEX_DAEMON_SOCKET', 'CODEY_CODEX_RUNTIME_TRANSPORT',
] as const;

async function withFixture(run: (fixture: {
  home: string;
  transcript: string;
  writeNames: (...names: string[]) => Promise<void>;
  synchronizer: CodexSessionSynchronizer;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-session-titles-'));
  const home = path.join(root, 'codex');
  const previousEnv = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  closeConnection();
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  process.env.CODEX_HOME = home;
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    const directory = path.join(home, 'sessions', '2026', '09', '18');
    await mkdir(directory, { recursive: true });
    const transcript = path.join(directory, `rollout-${THREAD_ID}.jsonl`);
    await writeFile(transcript, `${JSON.stringify({
      type: 'session_meta', payload: { id: THREAD_ID, cwd: '/workspace/demo' },
    })}\n`);
    await run({
      home, transcript, synchronizer: new CodexSessionSynchronizer(),
      writeNames: (...names) => writeFile(path.join(home, 'session_index.jsonl'),
        names.map((thread_name) => JSON.stringify({ id: THREAD_ID, thread_name })).join('\n') + '\n'),
    });
  } finally {
    closeConnection();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('Codex takes the latest appended title and follows index-only renames without changing recency', async () => {
  await withFixture(async ({ transcript, writeNames, synchronizer }) => {
    await writeNames('Original title', 'Renamed title');
    await synchronizer.synchronizeFile(transcript);
    const before = sessionsDb.getSessionById(THREAD_ID);
    assert.equal(before?.custom_name, 'Renamed title');
    assert.equal(before?.custom_name_source, 'auto');
    await writeNames('Original title', 'Renamed title', 'Latest title');
    assert.deepEqual(await synchronizeCodexSessionIndex(), [THREAD_ID]);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'Latest title');
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.updated_at, before?.updated_at);
    assert.deepEqual(await synchronizeCodexSessionIndex(), []);
  });
});

test('an incremental Codex scan refreshes old titles even when no new rollout passes its cursor', async () => {
  await withFixture(async ({ transcript, writeNames, synchronizer }) => {
    await writeNames('Original title');
    await synchronizer.synchronizeFile(transcript);
    await writeNames('Original title', 'Renamed without a new message');
    await synchronizer.synchronize(new Date(Date.now() + 60_000));
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'Renamed without a new message');
  });
});

test('a later rollout or index refresh cannot revert a newer native database name', async () => {
  await withFixture(async ({ home, transcript, writeNames, synchronizer }) => {
    await writeNames('Stale index title');
    const db = new Database(path.join(home, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)');
      db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'Current native name');
      await synchronizer.synchronizeFile(transcript);
      assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'Current native name');
      db.prepare('UPDATE threads SET name = ? WHERE id = ?').run('New native name', THREAD_ID);
      await synchronizeCodexSessionIndex();
      await synchronizer.synchronizeFile(transcript);
      assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'New native name');
      assert.equal(db.prepare<[string], { name: string }>('SELECT name FROM threads WHERE id = ?')
        .get(THREAD_ID)?.name, 'New native name');
    } finally {
      db.close();
    }
  });
});

test('filling an untitled Codex session does not accidentally turn its automatic title into an override', async () => {
  await withFixture(async ({ transcript, writeNames, synchronizer }) => {
    await synchronizer.synchronizeFile(transcript);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'Untitled Codex Session');
    await writeNames('Generated title');
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name_source, 'auto');
    await writeNames('Generated title', 'Changed later');
    await synchronizer.synchronizeFile(transcript);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'Changed later');
  });
});

test('index and rollout title updates preserve local overrides, archives and removed rows', async () => {
  await withFixture(async ({ transcript, writeNames, synchronizer }) => {
    await writeNames('Native title');
    await synchronizer.synchronizeFile(transcript);
    // Even a name identical to the old placeholder is an explicit user choice.
    sessionsDb.updateSessionCustomName(THREAD_ID, 'Untitled Codex Session');
    await writeNames('Native rename');
    assert.deepEqual(await synchronizeCodexSessionIndex(), []);
    await synchronizer.synchronizeFile(transcript);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.custom_name, 'Untitled Codex Session');
    sessionsDb.updateSessionIsArchived(THREAD_ID, true);
    assert.deepEqual(await synchronizeCodexSessionIndex(), []);
    assert.equal(await synchronizer.synchronizeFile(transcript), null);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.isArchived, 1);
    sessionsDb.deleteSessionById(THREAD_ID);
    assert.deepEqual(await synchronizeCodexSessionIndex(), []);
    assert.equal(sessionsDb.getSessionById(THREAD_ID), null);
  });
});
