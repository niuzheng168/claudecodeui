import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord } from '@/shared/index.js';

const THREAD_ID = 'native-desktop-thread';
const SECRET_SENTINEL = 'private-rpc-diagnostic-never-return';
const fakeServer = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.env.CODEY_TEST_READER_PID, String(process.pid));
const reply = (id, result) => console.log(JSON.stringify({id, result}));
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.CODEY_TEST_READER_LOG, JSON.stringify(request) + '\\n');
  if (!request.id) return;
  const behavior = process.env.CODEY_TEST_READER_BEHAVIOR;
  if (request.method === 'initialize') return reply(request.id, {});
  if (request.method === 'thread/loaded/list') {
    return reply(request.id, {data: behavior === 'loaded' ? ['${THREAD_ID}'] : []});
  }
  if (!['thread/read', 'thread/turns/list'].includes(request.method)) {
    throw new Error('Unexpected mutation attempted by history reader');
  }
  if (behavior === 'hang') return;
  if (behavior === 'rpc-error') {
    console.error('${SECRET_SENTINEL}');
    return console.log(JSON.stringify({id: request.id, error: {code: -32000, message: '${SECRET_SENTINEL}'}}));
  }
  const thread = {
    id: behavior === 'wrong-thread' ? 'another-owner-thread' : request.params.threadId,
    status: {type: 'notLoaded'}, createdAt: 1700000000,
    turns: [{
      id: 'original-turn', startedAt: 1700000000, status: 'completed',
      items: [
        {id: 'original-user', type: 'userMessage', content: [{type: 'text', text: 'Original native prompt'}]},
        {id: 'original-reply', type: 'agentMessage', text: 'Original native reply'},
      ],
    }],
  };
  if (request.method === 'thread/turns/list') {
    if (behavior === 'legacy') {
      return console.log(JSON.stringify({id: request.id, error: {code: -32601, message: 'Method not found'}}));
    }
    if (behavior === 'missing-turns') return reply(request.id, {});
    if (behavior === 'missing-items') delete thread.turns[0].items;
    if (behavior === 'paged') {
      if (!request.params.cursor) return reply(request.id, {data: thread.turns, nextCursor: 'page-2'});
      thread.turns[0].id = 'second-turn';
      thread.turns[0].items = [{id: 'second-reply', type: 'agentMessage', text: 'Second page reply'}];
    }
    return reply(request.id, {data: thread.turns, nextCursor: behavior === 'repeated-cursor' ? 'repeated' : null});
  }
  if (!request.params.includeTurns) thread.turns = [];
  reply(request.id, {thread});
});
`;

async function withReaderFixture(
  run: (fixture: { home: string; log: string; pidFile: string }) => Promise<void>,
  behavior = 'success',
): Promise<void> {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, 'codey-readonly-history-'));
  const home = path.join(root, 'home');
  const log = path.join(root, 'requests.jsonl');
  const pidFile = path.join(root, 'reader.pid');
  const values: Record<string, string> = {
    CODEX_HOME: home,
    CODEY_CODEX_DAEMON_SOCKET: '',
    CODEY_CODEX_RUNTIME_TRANSPORT: '',
    // Node runs the fixture's extensionless "app-server" entrypoint, not Codex.
    CODEY_CODEX_EXECUTABLE: process.execPath,
    DATABASE_PATH: path.join(root, 'auth.db'),
    CODEY_TEST_READER_LOG: log,
    CODEY_TEST_READER_PID: pidFile,
    CODEY_TEST_READER_BEHAVIOR: behavior,
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    await mkdir(home);
    await writeFile(path.join(home, 'package.json'), '{"type":"commonjs"}');
    await writeFile(path.join(home, 'app-server'), fakeServer);
    // Do not let test initialization copy any developer's legacy database.
    await writeFile(values.DATABASE_PATH, '');
    Object.assign(process.env, values);
    await run({ home, log, pidFile });
  } finally {
    closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Validate the exact generated directory before a recursive Windows cleanup.
    assert.equal(path.dirname(path.resolve(root)), temporaryParent);
    assert.ok(path.basename(root).startsWith('codey-readonly-history-'));
    await rm(root, { recursive: true, force: true });
  }
}

async function requestsAt(log: string): Promise<AnyRecord[]> {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as AnyRecord);
}

function historyUnavailable(error: unknown): boolean {
  const value = error as Error & { code?: string };
  return value.code === 'CODEX_HISTORY_UNAVAILABLE' && !value.message.includes(SECRET_SENTINEL);
}

test('desktop history uses only snapshot RPCs and leaves no loaded thread', { concurrency: false }, async () => {
  await withReaderFixture(async ({ log }) => {
    const snapshot = await codexAppServer.readThreadSnapshot(THREAD_ID);
    assert.equal(snapshot.id, THREAD_ID);
    assert.equal(snapshot.turns[0].items[1].text, 'Original native reply');
    const requests = await requestsAt(log);
    assert.deepEqual(requests.map(request => request.method), [
      'initialize', 'initialized', 'thread/read', 'thread/turns/list', 'thread/loaded/list',
    ]);
    assert.deepEqual(requests[2].params, { threadId: THREAD_ID, includeTurns: false });
    assert.deepEqual(requests[3].params, {
      threadId: THREAD_ID, cursor: null, limit: 100, sortDirection: 'asc', itemsView: 'full',
    });
    assert.equal(requests[0].params.capabilities.experimentalApi, true);
  });
});

test('native reader requires an explicit absolute CLI and never searches PATH', { concurrency: false }, async () => {
  await withReaderFixture(async ({ log }) => {
    for (const executable of [undefined, 'codex.exe']) {
      if (executable === undefined) delete process.env.CODEY_CODEX_EXECUTABLE;
      else process.env.CODEY_CODEX_EXECUTABLE = executable;
      await assert.rejects(codexAppServer.readThreadSnapshot(THREAD_ID),
        (error: unknown) => (error as { code?: string }).code === 'CODEX_HISTORY_READER_UNAVAILABLE');
    }
    await assert.rejects(readFile(log), { code: 'ENOENT' });
  });
});

for (const behavior of ['wrong-thread', 'missing-turns', 'missing-items', 'repeated-cursor', 'loaded', 'rpc-error']) {
  test(`native snapshot rejects ${behavior} instead of leaking or displaying partial history`, { concurrency: false }, async () => {
    await withReaderFixture(async ({ log }) => {
      await assert.rejects(codexAppServer.readThreadSnapshot(THREAD_ID), historyUnavailable);
      const requests = await requestsAt(log);
      assert.ok(requests.every(request => [
        'initialize', 'initialized', 'thread/read', 'thread/turns/list', 'thread/loaded/list',
      ].includes(request.method)));
    }, behavior);
  });
}

test('a hung read is bounded and terminates only its temporary reader', { concurrency: false }, async () => {
  await withReaderFixture(async ({ pidFile }) => {
    const started = Date.now();
    await assert.rejects(codexAppServer.readThreadSnapshot(THREAD_ID, { timeoutMs: 1000 }), historyUnavailable);
    assert.ok(Date.now() - started < 5000);
    const readerPid = Number(await readFile(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try { process.kill(readerPid, 0); } catch { alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(alive, false);
  }, 'hang');
});

test('every platform displays native history without trusting its partial export or exposing edit anchors', { concurrency: false }, async () => {
  await withReaderFixture(async ({ home, log }) => {
    closeConnection();
    await initializeDatabase();
    const statePath = path.join(home, 'state_5.sqlite');
    const state = new Database(statePath);
    state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    state.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    state.close();
    const partial = path.join(home, 'partial.jsonl');
    await writeFile(partial, JSON.stringify({
      type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Incomplete exported copy' }],
      },
    }) + '\n');
    sessionsDb.createSession(THREAD_ID, 'codex', home, 'Native session', undefined, undefined, partial);
    const stateHash = createHash('sha256').update(await readFile(statePath)).digest('hex');
    const provider = new CodexSessionsProvider();
    const history = await provider.fetchHistory(THREAD_ID);
    assert.equal(history.total, 2);
    assert.ok(history.messages.some(message => message.content === 'Original native reply'));
    assert.ok(!history.messages.some(message => message.content === 'Incomplete exported copy'));
    assert.ok(history.messages.every(message => !message.transcriptAnchorId));
    const page = await provider.fetchHistory(THREAD_ID, { limit: 1, offset: 0 });
    assert.equal(page.messages.length, 1);
    assert.equal(page.total, 2);
    assert.equal(page.hasMore, true);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.provider_session_id, THREAD_ID);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.jsonl_path, partial);
    assert.equal(createHash('sha256').update(await readFile(statePath)).digest('hex'), stateHash);
    const beforeFork = (await requestsAt(log)).length;
    await assert.rejects(codexAppServer.forkThread({ threadId: THREAD_ID, cwd: home }), /Fork or edit.*in Codex app/);
    assert.equal((await requestsAt(log)).length, beforeFork);
    // Reader failure must not fall back to the partial export as a "success".
    process.env.CODEY_TEST_READER_BEHAVIOR = 'rpc-error';
    await assert.rejects(provider.fetchHistory(THREAD_ID), historyUnavailable);
  });
});

test('native history without either backend fails closed on every platform', { concurrency: false }, async () => {
  await withReaderFixture(async ({ home, log }) => {
    delete process.env.CODEY_CODEX_EXECUTABLE;
    closeConnection();
    await initializeDatabase();
    const state = new Database(path.join(home, 'state_5.sqlite'));
    state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, history_mode TEXT);');
    state.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD_ID, 'paginated');
    state.close();
    sessionsDb.createSession(THREAD_ID, 'codex', home, 'Native session');
    await assert.rejects(new CodexSessionsProvider().fetchHistory(THREAD_ID),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_DAEMON_REQUIRED');
    await assert.rejects(readFile(log), { code: 'ENOENT' });
  });
});

test('native history reads all pages in order without loading a writer', { concurrency: false }, async () => {
  await withReaderFixture(async ({ log }) => {
    const snapshot = await codexAppServer.readThreadSnapshot(THREAD_ID);
    assert.deepEqual(snapshot.turns.map((turn: AnyRecord) => turn.id), ['original-turn', 'second-turn']);
    assert.equal(snapshot.turns[1].items[0].text, 'Second page reply');
    assert.deepEqual((await requestsAt(log)).filter(request => request.method === 'thread/turns/list')
      .map(request => request.params.cursor), [null, 'page-2']);
  }, 'paged');
});

test('older native readers use inclusive history only after an explicit unsupported-method response', { concurrency: false }, async t => {
  await withReaderFixture(async ({ log }) => {
    let snapshot: AnyRecord;
    try { snapshot = await codexAppServer.readThreadSnapshot(THREAD_ID); }
    catch (error) { t.diagnostic(JSON.stringify(await requestsAt(log))); throw error; }
    assert.equal(snapshot.turns[0].items[1].text, 'Original native reply');
    assert.deepEqual((await requestsAt(log)).map(request => request.method), [
      'initialize', 'initialized', 'thread/read', 'thread/turns/list', 'thread/read', 'thread/loaded/list',
    ]);
  }, 'legacy');
});
