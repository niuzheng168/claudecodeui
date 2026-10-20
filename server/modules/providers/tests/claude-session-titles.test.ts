import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const SESSION_ID = 'claude-title-session';
const ENVIRONMENT_KEYS = ['DATABASE_PATH', 'HOME'] as const;

type Fixture = {
  home: string;
  transcript: string;
  append: (...rows: Record<string, unknown>[]) => Promise<void>;
  sync: () => Promise<string | null>;
  name: (id?: string) => string | null | undefined;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-session-titles-'));
  const previousEnv = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  closeConnection();
  process.env.HOME = root;
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    const directory = path.join(root, '.claude', 'projects', '-workspace-demo');
    await mkdir(directory, { recursive: true });
    const transcript = path.join(directory, `${SESSION_ID}.jsonl`);
    const append = (...rows: Record<string, unknown>[]) => appendFile(
      transcript, rows.map((row) => `${JSON.stringify({ sessionId: SESSION_ID, ...row })}\n`).join(''),
    );
    await append({
      type: 'user', cwd: '/workspace/demo', message: { role: 'user', content: 'Fix the heartbeat reporting' },
    });
    // Constructed after HOME points at the fixture.
    const synchronizer = new ClaudeSessionSynchronizer();
    await run({
      home: root, transcript, append,
      sync: () => synchronizer.synchronizeFile(transcript),
      name: (id = SESSION_ID) => sessionsDb.getSessionById(id)?.custom_name,
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

test('a Claude CLI session keeps its first name across new prompts and follows native titles', async () => {
  await withFixture(async ({ home, append, sync, name }) => {
    await writeFile(path.join(home, '.claude', 'history.jsonl'),
      `${JSON.stringify({ sessionId: SESSION_ID, display: 'Fix the heartbeat reporting' })}\n`);
    await append({ type: 'last-prompt', lastPrompt: 'Fix the heartbeat reporting' });
    assert.equal(await sync(), SESSION_ID);
    assert.equal(name(), 'Fix the heartbeat reporting');

    // A new prompt is not a rename.
    await append({ type: 'last-prompt', lastPrompt: 'Now also add tests' });
    await sync();
    assert.equal(name(), 'Fix the heartbeat reporting');

    await append({ type: 'ai-title', aiTitle: 'Heartbeat reporting fix' });
    await sync();
    assert.equal(name(), 'Heartbeat reporting fix');

    // Claude Code shows a /rename over its generated title, even an older one.
    await append(
      { type: 'custom-title', customTitle: 'Mac node heartbeat' },
      { type: 'ai-title', aiTitle: 'Regenerated title' },
      { type: 'custom-title', customTitle: 'Other session', sessionId: 'another-session' },
      { type: 'last-prompt', lastPrompt: 'Keep going' },
    );
    await sync();
    assert.equal(name(), 'Mac node heartbeat');
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name_source, 'auto');

    await append({ type: 'custom-title', customTitle: '  Latest   rename ' });
    await sync();
    assert.equal(name(), 'Latest rename');
  });
});

test('an unnamed Claude session falls back to its last prompt', async () => {
  await withFixture(async ({ append, sync, name }) => {
    await sync();
    assert.equal(name(), 'Untitled Claude Session');
    await append({ type: 'last-prompt', lastPrompt: 'Investigate the offline node' });
    await sync();
    assert.equal(name(), 'Investigate the offline node');
    await append({ type: 'last-prompt', lastPrompt: 'A later prompt' });
    await sync();
    assert.equal(name(), 'Investigate the offline node');
  });
});

test('a Codey session keeps its generated title until a native rename, and a local rename always wins', async () => {
  await withFixture(async ({ append, sync, name }) => {
    sessionsDb.createAppSession('app', 'claude', '/workspace/demo', 'Fix the heartbeat reporting');
    sessionsDb.assignProviderSessionId('app', SESSION_ID);
    await append({ type: 'last-prompt', lastPrompt: 'Fix the heartbeat reporting' });
    assert.equal(await sync(), 'app');
    assert.equal(name('app'), 'Fix the heartbeat reporting');

    assert.equal(sessionsDb.updateSessionSyncedName('app', 'Heartbeat reporting fix', SESSION_ID), true);
    await append({ type: 'last-prompt', lastPrompt: 'Another prompt' });
    await sync();
    assert.equal(name('app'), 'Heartbeat reporting fix');

    await append({ type: 'custom-title', customTitle: 'Renamed in Claude Code' });
    await sync();
    assert.equal(name('app'), 'Renamed in Claude Code');

    sessionsDb.updateSessionCustomName('app', 'Renamed in Codey');
    await append({ type: 'custom-title', customTitle: 'Renamed again natively' });
    await sync();
    assert.equal(name('app'), 'Renamed in Codey');
    assert.equal(sessionsDb.getSessionById('app')?.custom_name_source, 'user');
    assert.equal(sessionsDb.getSessionById(SESSION_ID), null);
  });
});
