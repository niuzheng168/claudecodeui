import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionDraftsDb,
  userPreferencesDb,
} from '@/modules/database/index.js';

const USER_ID = 1;

test('queue operations preserve FIFO across stale devices, claims and a non-head restore', async () => {
  await withDatabase(() => {
    const messages = ['first', 'second', 'third', 'fourth'].map(id => ({ id, content: id, attachments: [] }));
    const append = (index: number) => sessionDraftsDb.saveDraft(USER_ID, 'session-a', {
      text: 'new typing', queueOperations: [{ kind: 'append', message: messages[index] }],
    });
    append(0);
    append(1);
    append(2);
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, messages.slice(0, 3));
    const second = sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a', 'second')!;
    assert.equal(sessionDraftsDb.claimQueuedMessage(second), true);
    assert.equal(sessionDraftsDb.claimQueuedMessage(second), false, 'one receipt can only be accepted once');
    const first = sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')!;
    assert.equal(sessionDraftsDb.claimQueuedMessage(first), true);
    append(3);
    assert.equal(sessionDraftsDb.restoreQueuedMessage(second), true);
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, messages.slice(1));
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0].text, 'new typing');
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', {
      text: 'still typing',
      // A stale snapshot from another device is deliberately ignored.
      queuedMessage: messages,
      queueOperations: [{ kind: 'remove', message: messages[2] }],
    });
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, [messages[1], messages[3]]);
    assert.equal(sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a', 'first'), null);
  });
});

test('appending to a legacy queue migrates it without replacing or duplicating its first receipt', async () => {
  await withDatabase(() => {
    const first = { id: 'old', content: 'old message' };
    const next = { id: 'new', content: 'new message' };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: first });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', {
      text: '', queueOperations: [{ kind: 'append', message: next }, { kind: 'append', message: next }],
    });
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, [first, next]);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', {
      text: '', queueOperations: [{ kind: 'remove', message: { ...next, content: 'stale edit' } }],
    });
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID)[0].queuedMessage, [first, next]);
  });
});

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'user-prefs-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  // Both tables cascade from users(id), so a row has to exist to write against.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');

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

test('preferences round-trip every JSON shape a setting can take', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });
  });
});

test('saving preferences merge-patches instead of replacing the whole set', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { theme: 'light' });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'light',
      userLanguage: 'de',
    });
  });
});

test('a preference set to undefined is removed', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { userLanguage: undefined });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('one unreadable preference value does not cost the user the others', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark' });
    getConnection()
      .prepare(
        `INSERT INTO user_preferences (user_id, preference_key, preference_value)
         VALUES (?, ?, ?)`
      )
      .run(USER_ID, 'broken', 'not json');

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('drafts round-trip text and queued message per scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'half typed', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'project:p1', {
      text: '',
      queuedMessage: { content: 'run it' },
    });

    const drafts = sessionDraftsDb.getDrafts(USER_ID);
    const byScope = new Map(drafts.map((draft) => [draft.scope, draft]));

    assert.equal(byScope.get('session-a')?.text, 'half typed');
    assert.equal(byScope.get('session-a')?.queuedMessage, null);
    assert.equal(byScope.get('project:p1')?.text, '');
    assert.deepEqual(byScope.get('project:p1')?.queuedMessage, { content: 'run it' });
  });
});

test('saving an empty draft deletes the row rather than keeping a blank one', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'typed', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: null });

    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('deleteDraft removes only the named scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'a', queuedMessage: null });
    sessionDraftsDb.saveDraft(USER_ID, 'session-b', { text: 'b', queuedMessage: null });

    sessionDraftsDb.deleteDraft(USER_ID, 'session-a');

    assert.deepEqual(
      sessionDraftsDb.getDrafts(USER_ID).map((draft) => draft.scope),
      ['session-b'],
    );
  });
});

test('queue claims compare both the owner and exact receipt, including identical-text replacements', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'next draft', queuedMessage: { id: 'old', content: 'same' } });
    const receipt = sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')!;
    assert.equal(sessionDraftsDb.getQueuedMessage(USER_ID + 1, 'session-a'), null);
    assert.equal(sessionDraftsDb.claimQueuedMessage({ ...receipt, userId: USER_ID + 1 }), false);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'next draft', queuedMessage: { id: 'new', content: 'same' } });
    assert.equal(sessionDraftsDb.claimQueuedMessage(receipt), false);
    const next = sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')!;
    assert.equal(sessionDraftsDb.claimQueuedMessage(next), true);
    assert.equal(sessionDraftsDb.claimQueuedMessage(next), false);
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0].text, 'next draft');
    assert.equal(sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a'), null);
  });
});

test('text-only autosaves neither resurrect claimed queues nor erase another device queue', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: { id: 'q', content: 'first' } });
    sessionDraftsDb.claimQueuedMessage(sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')!);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'still typing' });
    assert.equal(sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a'), null);
    const replacement = { id: 'other-device', content: 'later' };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: replacement });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '' });
    assert.deepEqual(sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')?.queuedMessage, replacement);
    sessionDraftsDb.claimQueuedMessage(sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')!);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '' });
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('restoring a failed claim preserves new text, recreates cleaned rows and never overwrites a newer queue', async () => {
  await withDatabase(() => {
    const original = { id: 'q', content: 'first' };
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: original });
    const receipt = sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')!;
    sessionDraftsDb.claimQueuedMessage(receipt);
    sessionDraftsDb.deleteEmptyDraft(USER_ID, 'session-a');
    assert.equal(sessionDraftsDb.restoreQueuedMessage(receipt), true);
    sessionDraftsDb.claimQueuedMessage(receipt);
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'typing meanwhile' });
    assert.equal(sessionDraftsDb.restoreQueuedMessage(receipt), true);
    assert.equal(sessionDraftsDb.getDrafts(USER_ID)[0].text, 'typing meanwhile');
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'newer', queuedMessage: { id: 'new', content: 'new' } });
    assert.equal(sessionDraftsDb.restoreQueuedMessage(receipt), false);
    assert.deepEqual(sessionDraftsDb.getQueuedMessage(USER_ID, 'session-a')?.queuedMessage, { id: 'new', content: 'new' });
  });
});
