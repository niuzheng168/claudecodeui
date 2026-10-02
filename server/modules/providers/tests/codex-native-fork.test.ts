import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import type { AnyRecord } from '@/shared/index.js';

test('native fork uses the selected runtime once, excludes history, and never resumes or changes the source', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codey-native-fork-'));
  const oldHome = process.env.CODEX_HOME;
  const oldTransport = process.env.CODEY_CODEX_RUNTIME_TRANSPORT;
  const connect = CodexDaemonClient.connect;
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  let closes = 0;
  let fail = false;
  const state = new Database(path.join(home, 'state_5.sqlite'));
  state.exec("CREATE TABLE threads (id TEXT, history_mode TEXT); INSERT INTO threads VALUES ('source', 'paginated')");
  state.close();
  process.env.CODEX_HOME = home;
  delete process.env.CODEY_CODEX_RUNTIME_TRANSPORT;
  CodexDaemonClient.connect = async () => ({
    request: async (method: string, params: AnyRecord) => {
      calls.push({ method, params });
      if (fail) throw new Error('connection lost after submission');
      return { thread: { id: 'forked', path: null, historyMode: 'paginated' } };
    },
    close: async () => { closes++; },
  } as unknown as CodexDaemonClient);
  try {
    assert.deepEqual(await codexAppServer.forkThread({
      threadId: 'source', cwd: home, lastTurnId: 'completed-turn', allowNative: true,
    }), { threadId: 'forked', path: '' });
    assert.deepEqual(calls, [{
      method: 'thread/fork',
      params: { threadId: 'source', cwd: home, lastTurnId: 'completed-turn', excludeTurns: true, deferGoalContinuation: true },
    }]);
    assert.equal(closes, 1);
    await assert.rejects(codexAppServer.forkThread({ threadId: 'source', cwd: home }), {
      code: 'CODEX_NATIVE_FORK_UNSUPPORTED',
    });
    assert.equal(calls.length, 1, 'legacy edit paths remain protected');
    fail = true;
    await assert.rejects(codexAppServer.forkThread({ threadId: 'source', cwd: home, allowNative: true }));
    assert.equal(calls.length, 2, 'an ambiguous mutation is not retried');
    assert.equal(closes, 2);
  } finally {
    CodexDaemonClient.connect = connect;
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    if (oldTransport === undefined) delete process.env.CODEY_CODEX_RUNTIME_TRANSPORT;
    else process.env.CODEY_CODEX_RUNTIME_TRANSPORT = oldTransport;
    await rm(home, { recursive: true, force: true });
  }
});
