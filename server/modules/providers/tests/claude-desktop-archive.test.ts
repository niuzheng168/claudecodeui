import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeDesktopArchiveDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  passOnClaudeDesktopArchive,
  synchronizeClaudeDesktopArchive,
} from '@/modules/providers/list/claude/claude-desktop-archive.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-desktop-archive-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A Claude Desktop data folder with its records under claude-code-sessions/<account>/<organization>. */
async function withDesktopFolder(runTest: (folder: string, write: (name: string, record: unknown) => Promise<void>) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'claude-desktop-data-'));
  const records = path.join(folder, 'claude-code-sessions', 'account-1', 'organization-1');
  await mkdir(records, { recursive: true });
  // Each write gets a later modification time, which is what tells a pass to read the record again.
  let clock = Date.parse('2026-10-27T00:00:00Z');
  const write = async (name: string, record: unknown) => {
    const file = path.join(records, name);
    await writeFile(file, typeof record === 'string' ? record : JSON.stringify(record), 'utf8');
    clock += 1000;
    await utimes(file, new Date(clock), new Date(clock));
  };
  try {
    await runTest(folder, write);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// Desktop's last activity in these sessions, and a last message in Codey from just before it.
const DESKTOP_ACTIVITY = Date.parse('2026-10-23T10:51:19.345Z');
const LAST_MESSAGE = '2026-10-23T10:51:18.940Z';

const record = (cliSessionId: string, isArchived: boolean, extra: Record<string, unknown> = {}) => ({
  sessionId: `local_${cliSessionId}`, cliSessionId, isArchived, cwd: '/home/operator/g/vienna', lastActivityAt: DESKTOP_ACTIVITY, ...extra,
});
const overSsh = { sshConfig: { sshHost: 'jpe3' } };
const isArchived = (sessionId: string) => sessionsDb.getSessionById(sessionId)?.isArchived;
const indexSession = (id: string, updatedAt = LAST_MESSAGE) => {
  sessionsDb.createSession(id, 'claude', '/home/operator/g/vienna', id, '2026-10-23T10:00:00.000Z', updatedAt);
};

test('sessions Claude Desktop has archived are archived in Codey, and the ones it runs elsewhere wait to be passed on', { concurrency: false }, async () => {
  await withDesktopFolder(async (folder, write) => {
    await withIsolatedDatabase(async () => {
      // One Desktop runs here, a copy of one it runs over SSH, one it has not archived,
      // and one Codey started (its app id is not the Claude Code session id).
      indexSession('local-1');
      indexSession('remote-1');
      indexSession('open-1');
      sessionsDb.createAppSession('app-1', 'claude', '/home/operator/g/vienna', 'Started in Codey');
      sessionsDb.assignProviderSessionId('app-1', 'claude-1');
      // Indexing its transcript dates it by its last message.
      sessionsDb.createSession('claude-1', 'claude', '/home/operator/g/vienna', 'Started in Codey', undefined, LAST_MESSAGE);
      await write('local_a.json', record('local-1', true));
      await write('local_b.json', record('remote-1', true, overSsh));
      await write('local_c.json', record('open-1', false, overSsh));
      await write('local_d.json', record('claude-1', true));
      await write('archived-sessions.idx', { v: 1, archived: ['local_a', 'local_b', 'local_d'] });

      const changes = await synchronizeClaudeDesktopArchive([folder]);
      assert.deepEqual(changes.archived.sort(), ['app-1', 'local-1', 'remote-1']);
      assert.deepEqual(changes.restored, []);
      assert.equal(changes.passOn, true);
      assert.equal(isArchived('open-1'), 0);
      assert.deepEqual(claudeDesktopArchiveDb.listPending(), [{ providerSessionId: 'remote-1', archived: true, desktopActivityAt: DESKTOP_ACTIVITY }]);

      // Nothing changed in Desktop: nothing to do.
      assert.deepEqual(await synchronizeClaudeDesktopArchive([folder]), { archived: [], restored: [], passOn: false });
    });
  });
});

test('only a change in Desktop is carried over, so a session brought back in Codey stays back', { concurrency: false }, async () => {
  await withDesktopFolder(async (folder, write) => {
    await withIsolatedDatabase(async () => {
      indexSession('local-1');
      await write('local_a.json', record('local-1', true));
      await synchronizeClaudeDesktopArchive([folder]);
      assert.equal(isArchived('local-1'), 1);

      sessionsDb.updateSessionIsArchived('local-1', false);
      await synchronizeClaudeDesktopArchive([folder]);
      assert.equal(isArchived('local-1'), 0);

      // Restored in Desktop, then archived there again.
      sessionsDb.updateSessionIsArchived('local-1', true);
      await write('local_a.json', record('local-1', false));
      assert.deepEqual(await synchronizeClaudeDesktopArchive([folder]), { archived: [], restored: ['local-1'], passOn: false });
      await write('local_a.json', record('local-1', true));
      assert.deepEqual(await synchronizeClaudeDesktopArchive([folder]), { archived: ['local-1'], restored: [], passOn: false });

      // A session first seen unarchived leaves an archive made in Codey alone.
      indexSession('codey-archived');
      sessionsDb.updateSessionIsArchived('codey-archived', true);
      await write('local_b.json', record('codey-archived', false));
      await synchronizeClaudeDesktopArchive([folder]);
      assert.equal(isArchived('codey-archived'), 1);
    });
  });
});

test('a session continued in Codey after Desktop last used it is not archived with Desktop', { concurrency: false }, async () => {
  await withDesktopFolder(async (folder, write) => {
    await withIsolatedDatabase(async () => {
      // Its transcript has a reply from an hour after Desktop's last activity; the index's date is older.
      const transcript = path.join(folder, 'continued-1.jsonl');
      await writeFile(transcript, `${JSON.stringify({
        type: 'assistant', uuid: 'm-2', sessionId: 'continued-1', timestamp: '2026-10-23T11:51:19.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done here.' }] },
      })}\n`, 'utf8');
      sessionsDb.createSession('continued-1', 'claude', '/home/operator/g/vienna', 'Continued', undefined, LAST_MESSAGE, transcript);
      // Clocks a little apart do not count.
      indexSession('close-1', '2026-10-23T10:52:19.000Z');
      await write('local_a.json', record('continued-1', true));
      await write('local_b.json', record('close-1', true));

      const changes = await synchronizeClaudeDesktopArchive([folder]);
      assert.deepEqual(changes.archived, ['close-1']);
      assert.equal(isArchived('continued-1'), 0);
    });
  });
});

test('earlier Claude Code sessions of a Desktop session follow its archive, unless another record runs them', { concurrency: false }, async () => {
  await withDesktopFolder(async (folder, write) => {
    await withIsolatedDatabase(async () => {
      for (const id of ['now-1', 'before-1', 'before-2']) indexSession(id);
      await write('local_a.json', record('now-1', true, { priorRemoteCliSessionIds: ['before-1', 'before-2'] }));
      // A fork Desktop runs on its own still uses before-2.
      await write('local_b.json', record('before-2', false));
      await write('local_c.json', '{"cliSessionId": "half-writt');

      const changes = await synchronizeClaudeDesktopArchive([folder]);
      assert.deepEqual(changes.archived.sort(), ['before-1', 'now-1']);
      assert.equal(isArchived('before-2'), 0);
    });
  });
});

test('a record caught while Desktop rewrites it keeps the state read before', { concurrency: false }, async () => {
  await withDesktopFolder(async (folder, write) => {
    await withIsolatedDatabase(async () => {
      indexSession('local-1');
      await write('local_a.json', record('local-1', false));
      await synchronizeClaudeDesktopArchive([folder]);

      await write('local_a.json', '{"cliSessionId": "local-1", "isArch');
      assert.deepEqual(await synchronizeClaudeDesktopArchive([folder]), { archived: [], restored: [], passOn: false });
      await write('local_a.json', record('local-1', true));
      assert.deepEqual((await synchronizeClaudeDesktopArchive([folder])).archived, ['local-1']);
    });
  });
});

test('changes to sessions Desktop runs elsewhere are passed on until a machine lists them or every machine answered', { concurrency: false }, async () => {
  await withDesktopFolder(async (folder, write) => {
    await withIsolatedDatabase(async () => {
      await write('local_a.json', record('on-jpe3', true, overSsh));
      await write('local_b.json', record('on-offline', true, overSsh));
      await write('local_c.json', record('on-other-host', true, { sshConfig: { sshHost: 'homedev' } }));
      await synchronizeClaudeDesktopArchive([folder]);

      const sent: unknown[] = [];
      let unreachable = ['n-macbook'];
      const request = async (method: string, pathname: string, { body }: { body?: unknown }) => {
        assert.equal(method, 'POST');
        assert.equal(pathname, '/api/v1/sessions/archive');
        sent.push(body);
        const sessions = (body as { sessions: Array<{ sessionId: string; archived: boolean }> }).sessions;
        return {
          sessions: sessions.map((session) => ({ ...session, provider: 'claude', machines: session.sessionId === 'on-jpe3' ? ['n-jpe3'] : [] })),
          unreachable,
        };
      };
      const now = Date.parse('2026-10-27T10:00:00Z');
      await passOnClaudeDesktopArchive({ immediately: true, request, now });
      assert.deepEqual(sent[0], {
        sessions: ['on-jpe3', 'on-offline', 'on-other-host'].map((sessionId) => ({
          provider: 'claude', sessionId, archived: true, lastActivityAt: '2026-10-23T10:51:19.345Z',
        })),
      });
      // on-jpe3 reached its machine; the others may be on the machine that did not answer.
      assert.deepEqual(claudeDesktopArchiveDb.listPending().map((change) => change.providerSessionId), ['on-offline', 'on-other-host']);

      // Not again until the retry is due, unless Desktop changes something.
      await passOnClaudeDesktopArchive({ request, now: now + 60_000 });
      assert.equal(sent.length, 1);
      unreachable = [];
      await passOnClaudeDesktopArchive({ request, now: now + 6 * 60_000 });
      assert.equal(sent.length, 2);
      assert.deepEqual(claudeDesktopArchiveDb.listPending(), []);

      // Outside a Codey node there is no Portal to ask, and changes wait.
      await write('local_a.json', record('on-jpe3', false, overSsh));
      assert.equal((await synchronizeClaudeDesktopArchive([folder])).passOn, true);
      await passOnClaudeDesktopArchive({ immediately: true, request: null, now: now + 7 * 60_000 });
      assert.deepEqual(claudeDesktopArchiveDb.listPending(), [{ providerSessionId: 'on-jpe3', archived: false, desktopActivityAt: DESKTOP_ACTIVITY }]);
    });
  });
});

test('on a Codey node the codey package\'s Portal client carries the changes', { concurrency: false }, async () => {
  await withDesktopFolder(async (folder, write) => {
    await withIsolatedDatabase(async () => {
      // What packages/codey/lib/workspace.mjs names: a module whose portalRequest signs as this node.
      const client = path.join(folder, 'portal-client.mjs');
      await writeFile(client, `export async function portalRequest(method, pathname, { body }) {
        (globalThis.portalCalls ??= []).push({ method, pathname, body });
        return { sessions: body.sessions.map((session) => ({ ...session, machines: ['n-jpe3'] })), unreachable: [] };
      }\n`, 'utf8');
      const previous = process.env.CODEY_PORTAL_CLIENT_MODULE;
      process.env.CODEY_PORTAL_CLIENT_MODULE = client;
      try {
        await write('local_a.json', record('on-jpe3', true, overSsh));
        await synchronizeClaudeDesktopArchive([folder]);
        await passOnClaudeDesktopArchive({ immediately: true });
      } finally {
        if (previous === undefined) delete process.env.CODEY_PORTAL_CLIENT_MODULE;
        else process.env.CODEY_PORTAL_CLIENT_MODULE = previous;
      }
      const calls = (globalThis as { portalCalls?: Array<{ method: string; pathname: string }> }).portalCalls ?? [];
      assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), ['POST /api/v1/sessions/archive']);
      assert.deepEqual(claudeDesktopArchiveDb.listPending(), []);
    });
  });
});
