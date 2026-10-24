import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';
import { sessionsService } from '@/modules/providers/index.js';

/**
 * A permanent project delete unlinks every session transcript of the project.
 * Native Codex threads still live in Codex's own databases and read those
 * files, so removing them leaves a thread without its history in Codex app.
 * The project delete must refuse them as the single-session delete does.
 */

const PROJECT_PATH = '/tmp/project-delete-fixture';

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function withFixture(
  runTest: (fixture: { transcripts: string; threads: Database.Database }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-delete-'));
  const codexHome = path.join(root, 'codex');
  const transcripts = path.join(root, 'transcripts');
  await mkdir(codexHome, { recursive: true });
  await mkdir(transcripts, { recursive: true });
  const threads = new Database(path.join(codexHome, 'state_5.sqlite'));
  threads.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT)');

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.CODEX_HOME = codexHome;
  await initializeDatabase();

  try {
    await runTest({ transcripts, threads });
  } finally {
    threads.close();
    closeConnection();
    for (const [name, value] of [['DATABASE_PATH', previousDatabasePath], ['CODEX_HOME', previousCodexHome]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function transcript(directory: string, name: string): Promise<string> {
  const file = path.join(directory, `${name}.jsonl`);
  await writeFile(file, '{}\n');
  return file;
}

function projectId(): string {
  const row = projectsDb.getProjectPath(PROJECT_PATH);
  assert.ok(row, 'the fixture project exists');
  return row.project_id;
}

test('a permanent project delete leaves native Codex history and everything else untouched', async () => {
  await withFixture(async ({ transcripts, threads }) => {
    const claudeFile = await transcript(transcripts, 'claude');
    const nativeFile = await transcript(transcripts, 'native');
    sessionsDb.createSession('claude-session', 'claude', PROJECT_PATH, 'Claude', undefined, undefined, claudeFile);
    sessionsDb.createSession('native-thread', 'codex', PROJECT_PATH, 'Native', undefined, undefined, nativeFile);
    threads.prepare('INSERT INTO threads VALUES (?, ?)').run('native-thread', 'paginated');
    const id = projectId();

    await assert.rejects(deleteOrArchiveProject(id, true), (error: Error & { statusCode?: number; code?: string }) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'CODEX_NATIVE_DELETE_UNSUPPORTED');
      assert.match(error.message, /1 Codex session .*Codex app/);
      return true;
    });
    assert.ok(await exists(nativeFile), 'the native rollout stays');
    assert.ok(await exists(claudeFile), 'nothing is removed when the delete is refused');
    assert.ok(sessionsDb.getSessionById('claude-session'));
    assert.ok(sessionsDb.getSessionById('native-thread'));
    assert.ok(projectsDb.getProjectById(id));

    // Removing the project without its data still works.
    await deleteOrArchiveProject(id, false);
    assert.equal(projectsDb.getProjectById(id)?.isArchived, 1);
  });
});

test('a conversation edited away from a native thread is refused too', async () => {
  await withFixture(async ({ transcripts, threads }) => {
    const currentFile = await transcript(transcripts, 'current');
    const replacedFile = await transcript(transcripts, 'replaced');
    sessionsDb.createSession('edited', 'codex', PROJECT_PATH, 'Edited', undefined, undefined, currentFile);
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: 'replaced-thread', provider: 'codex', sessionId: 'edited', jsonlPath: replacedFile,
    });
    threads.prepare('INSERT INTO threads VALUES (?, ?)').run('replaced-thread', 'paginated');

    await assert.rejects(deleteOrArchiveProject(projectId(), true), /Codex app/);
    await assert.rejects(
      sessionsService.deleteOrArchiveSessionById('edited', { force: true, deletedFromDisk: true }),
      /Permanently delete this native session in Codex app/,
    );
    assert.ok(await exists(replacedFile));
    assert.ok(await exists(currentFile));
  });
});

test('legacy Codex rollouts and other providers are still deleted with the project', async () => {
  await withFixture(async ({ transcripts, threads }) => {
    const claudeFile = await transcript(transcripts, 'claude');
    const legacyFile = await transcript(transcripts, 'legacy');
    const unknownFile = await transcript(transcripts, 'unknown');
    sessionsDb.createSession('claude-session', 'claude', PROJECT_PATH, 'Claude', undefined, undefined, claudeFile);
    sessionsDb.createSession('legacy-thread', 'codex', PROJECT_PATH, 'Legacy', undefined, undefined, legacyFile);
    // A thread Codex does not track (an old rollout) has no history mode at all.
    sessionsDb.createSession('untracked-thread', 'codex', PROJECT_PATH, 'Untracked', undefined, undefined, unknownFile);
    threads.prepare('INSERT INTO threads VALUES (?, ?)').run('legacy-thread', 'legacy');
    const id = projectId();

    await deleteOrArchiveProject(id, true);

    for (const file of [claudeFile, legacyFile, unknownFile]) assert.equal(await exists(file), false, file);
    assert.equal(sessionsDb.getSessionById('claude-session'), null);
    assert.equal(sessionsDb.getSessionById('legacy-thread'), null);
    assert.equal(projectsDb.getProjectById(id), null);
  });
});
