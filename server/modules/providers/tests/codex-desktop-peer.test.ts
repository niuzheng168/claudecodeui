import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexDesktopPeerClient } from '@/modules/providers/list/codex/codex-desktop-peer.client.js';
import type { AnyRecord } from '@/shared/index.js';

async function fixture(
  body: (f: { home: string; endpoint: string; calls: AnyRecord[]; connect: () => Promise<CodexDesktopPeerClient | null> }) => Promise<void>,
  options: {
    noOwner?: boolean; rejectStart?: boolean; lostAck?: boolean; wrongOwner?: boolean;
    invalidHandshake?: boolean; invalidFrame?: boolean;
    state?: AnyRecord; staleSnapshot?: boolean; staleRevision?: boolean; wrongTurn?: boolean; noTurnReceipt?: boolean;
    rejectControl?: boolean; ownerDisconnected?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const parent = process.platform === 'win32' ? path.resolve(os.tmpdir()) : '/tmp';
  const home = await mkdtemp(path.join(parent, 'codey-desktop-peer-'));
  const directory = path.join(home, 'ipc');
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\codey-peer-test-${randomUUID()}` : path.join(directory, 'ipc.sock');
  await mkdir(directory, { mode: 0o700 });
  const calls: AnyRecord[] = [];
  const sockets = new Set<net.Socket>();
  const send = (socket: net.Socket, message: AnyRecord) => {
    const payload = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(payload.length + 4);
    frame.writeUInt32LE(payload.length);
    payload.copy(frame, 4);
    // Exercise a split length header and a split JSON payload.
    socket.write(frame.subarray(0, 2));
    socket.write(frame.subarray(2, 11));
    socket.write(frame.subarray(11));
  };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffered: Buffer = Buffer.alloc(0);
    let snapshots = 0;
    socket.on('data', data => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (buffered.length < size + 4) return;
        const message = JSON.parse(buffered.subarray(4, size + 4).toString('utf8')) as AnyRecord;
        buffered = buffered.subarray(size + 4);
        calls.push(message);
        if (message.type === 'broadcast' && message.method === 'thread-stream-following-changed') {
          if (!message.params.following) continue;
          const snapshot = {
            type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop-owner',
            params: { hostId: 'local', conversationId: 'desktop-thread', change: {
              type: 'snapshot', revision: 1,
              conversationState: options.state ?? {
                id: 'desktop-thread', cwd: '/workspace',
                turns: [{ turnId: 'own-turn', status: 'inProgress' }],
              },
            } },
          };
          // A different owner/host/thread must never satisfy this read, even
          // if its snapshot arrived before the pinned owner's response.
          send(socket, { ...snapshot, sourceClientId: 'another-owner' });
          send(socket, { ...snapshot, params: { ...snapshot.params, conversationId: 'another-thread' } });
          send(socket, { ...snapshot, params: { ...snapshot.params, hostId: 'remote-host' } });
          if (options.staleRevision && snapshots++ > 0) {
            send(socket, { ...snapshot, params: { ...snapshot.params, change: {
              ...snapshot.params.change, revision: 0,
              conversationState: { id: 'desktop-thread', turns: [{ turnId: 'old-turn', status: 'inProgress' }] },
            } } });
          }
          if (!options.staleSnapshot) send(socket, snapshot);
          if (options.ownerDisconnected) {
            send(socket, {
              type: 'broadcast', method: 'client-status-changed', version: 0,
              sourceClientId: 'desktop-owner',
              params: { clientId: 'desktop-owner', status: 'disconnected' },
            });
          }
          continue;
        }
        if (message.type !== 'request') continue;
        const response = { type: 'response', requestId: message.requestId, method: message.method, resultType: 'success' };
        if (message.method === 'initialize') {
          if (options.invalidFrame) {
            const bad = Buffer.alloc(4); bad.writeUInt32LE(100_000_000); socket.write(bad); continue;
          }
          send(socket, { ...response, result: options.invalidHandshake ? {} : { clientId: 'codey-peer' } });
          send(socket, { type: 'client-discovery-request', requestId: 'foreign-discovery', request: { method: 'thread-owner-discovery' } });
        } else if (message.method === 'thread-owner-discovery') {
          send(socket, options.noOwner
            ? { ...response, resultType: 'error', error: 'no-client-found' }
            : { ...response, handledByClientId: 'desktop-owner', result: { supportsUntrustedAppInput: true } });
        } else if (message.method === 'thread-follower-start-turn') {
          if (options.lostAck) { socket.destroy(); continue; }
          send(socket, options.rejectStart
            ? { ...response, resultType: 'error', error: 'PRIVATE_OWNER_ERROR_DO_NOT_EXPORT' }
            : { ...response, handledByClientId: options.wrongOwner ? 'unrelated-owner' : 'desktop-owner', result: { result: { turn: { id: 'own-turn' } } } });
        } else if (['thread-follower-steer-turn', 'thread-follower-interrupt-turn'].includes(message.method)) {
          if (options.lostAck) { socket.destroy(); continue; }
          const turnId = options.wrongTurn ? 'later-turn' : 'own-turn';
          send(socket, {
            ...response, handledByClientId: options.wrongOwner ? 'unrelated-owner' : 'desktop-owner',
            ...(options.rejectControl ? { resultType: 'error', error: 'PRIVATE_OWNER_ERROR_DO_NOT_EXPORT' } : {}),
            result: options.noTurnReceipt ? {} : message.method === 'thread-follower-steer-turn'
              ? { result: { turnId } } : { ok: true, interruptedTurnId: turnId },
          });
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(endpoint, resolve);
    });
    await body({ home, endpoint, calls, connect: () => CodexDesktopPeerClient.connect('desktop-thread', {
      home: process.platform === 'win32' ? path.join(os.homedir(), '.codex') : home,
      timeoutMs: options.timeoutMs ?? 500,
      // Only this test's random pipe/socket is used, never the real desktop.
      connectSocket: () => net.createConnection({ path: endpoint }),
    }) });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(home)), parent);
    assert.ok(path.basename(home).startsWith('codey-desktop-peer-'));
    await rm(home, { recursive: true, force: true });
  }
}

test('desktop peer discovers and pins the native owner, keeping the input identity and settings', async () => {
  await fixture(async f => {
    const client = await f.connect();
    assert.ok(client);
    const input = [{ type: 'text', text: 'continue' }, { type: 'localImage', path: '/Users/Owner/image.png' }];
    try { await client.startTurn(input, 'browser-input-id'); }
    finally { client.close(); }
    assert.deepEqual(f.calls.filter(x => x.type === 'request').map(x => [x.method, x.version]), [
      ['initialize', 0], ['thread-owner-discovery', 1], ['thread-follower-start-turn', 2],
    ]);
    assert.deepEqual(f.calls[0].params, { clientType: 'codey' });
    const discover = f.calls.find(x => x.method === 'thread-owner-discovery');
    assert.deepEqual(discover?.params, { hostId: 'local', conversationId: 'desktop-thread' });
    const start = f.calls.find(x => x.method === 'thread-follower-start-turn');
    assert.equal(start?.targetClientId, 'desktop-owner');
    assert.equal(start?.sourceClientId, 'codey-peer');
    assert.deepEqual(start?.params, {
      conversationId: 'desktop-thread',
      turnStart: {
        request: { threadId: 'desktop-thread', clientUserMessageId: 'browser-input-id', input },
        context: { inheritThreadSettings: true },
      },
    });
    assert.deepEqual(f.calls.find(x => x.type === 'client-discovery-response')?.response, { canHandle: false });
    assert.ok(!f.calls.some(x => ['thread/resume', 'thread/queue/add', 'thread/start'].includes(x.method)));
  });
});

test('absent desktop owner is a read-only capability result, never a turn or queue submission', async () => {
  await fixture(async f => {
    assert.equal(await f.connect(), null);
    assert.ok(!f.calls.some(x => x.method === 'thread-follower-start-turn'));
  }, { noOwner: true });
});

test('missing private IPC endpoint returns null without creating one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codey-peer-absent-'));
  try { assert.equal(await CodexDesktopPeerClient.connect('thread', { home }), null); }
  finally { await rm(home, { recursive: true, force: true }); }
});

test('untrusted or linked peer directories are refused before connecting', { skip: process.platform === 'win32' }, async () => {
  await fixture(async f => {
    await chmod(path.join(f.home, 'ipc'), 0o755);
    await assert.rejects(f.connect(), { code: 'CODEX_DESKTOP_PEER_UNTRUSTED' });
    assert.equal(f.calls.length, 0);
    await chmod(path.join(f.home, 'ipc'), 0o700);
    const other = await mkdtemp(path.join(os.tmpdir(), 'codey-peer-linked-'));
    try {
      await symlink(path.join(f.home, 'ipc'), path.join(other, 'ipc'));
      await assert.rejects(CodexDesktopPeerClient.connect('thread', { home: other }), { code: 'CODEX_DESKTOP_PEER_UNTRUSTED' });
      assert.equal(f.calls.length, 0);
    } finally { await rm(other, { recursive: true, force: true }); }
  });
});

test('a regular file cannot impersonate the desktop peer socket', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codey-peer-file-'));
  try {
    await mkdir(path.join(home, 'ipc'), { mode: 0o700 });
    await writeFile(path.join(home, 'ipc/ipc.sock'), '');
    await assert.rejects(CodexDesktopPeerClient.connect('thread', { home }), { code: 'CODEX_DESKTOP_PEER_UNTRUSTED' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('handshake and frame validation fail closed without submitting input', async () => {
  for (const options of [{ invalidHandshake: true }, { invalidFrame: true }]) {
    await fixture(async f => {
      await assert.rejects(f.connect(), { code: 'CODEX_DESKTOP_PEER_PROTOCOL_ERROR' });
      assert.ok(!f.calls.some(x => x.method === 'thread-follower-start-turn'));
    }, options);
  }
});

test('owner rejection, lost acknowledgement and wrong-owner replies never retry', async () => {
  for (const options of [{ rejectStart: true }, { lostAck: true }, { wrongOwner: true }]) {
    await fixture(async f => {
      const client = await f.connect();
      assert.ok(client);
      try {
        await assert.rejects(client.startTurn([{ type: 'text', text: 'exactly once' }], 'client-id'),
          (error: AnyRecord) => error.code === 'CODEX_DESKTOP_SUBMISSION_UNCONFIRMED'
            && !error.message.includes('PRIVATE_OWNER_ERROR'));
      } finally { client.close(); }
      assert.equal(f.calls.filter(x => x.method === 'thread-follower-start-turn').length, 1);
      assert.ok(!f.calls.some(x => x.method === 'thread/queue/add'));
    }, options);
  }
});

test('Linux and macOS use the CODEX_HOME-scoped IPC endpoint', { skip: process.platform === 'win32' }, async () => {
  await fixture(async f => {
    for (const platform of ['linux', 'darwin'] as const) {
      let seen: string | undefined;
      const client = await CodexDesktopPeerClient.connect('desktop-thread', {
        home: f.home, platform,
        connectSocket: endpoint => { seen = endpoint; return net.createConnection({ path: endpoint }); },
      });
      assert.ok(client); client.close();
      assert.equal(seen, f.endpoint);
    }
  });
});

test('Windows uses the desktop named pipe only for the shared default profile', async () => {
  await fixture(async f => {
    let seen: string | undefined;
    const isolated = await CodexDesktopPeerClient.connect('desktop-thread', {
      home: f.home, platform: 'win32',
      connectSocket: endpoint => { seen = endpoint; return net.createConnection({ path: f.endpoint }); },
    });
    assert.equal(isolated, null);
    assert.equal(seen, undefined);
    const client = await CodexDesktopPeerClient.connect('desktop-thread', {
      home: path.join(os.homedir(), '.codex'), platform: 'win32',
      connectSocket: endpoint => { seen = endpoint; return net.createConnection({ path: f.endpoint }); },
    });
    assert.ok(client); client.close();
    assert.equal(seen, '\\\\.\\pipe\\codex-ipc');
  });
});

test('a live desktop snapshot is read-only, owner-bound and requested afresh for each control', async () => {
  await fixture(async f => {
    const client = await f.connect();
    assert.ok(client);
    try {
      assert.deepEqual(await client.readState(), { activeTurnId: 'own-turn', cwd: '/workspace' });
      const input = [{ type: 'text', text: 'Correct this turn' }, { type: 'localImage', path: '/workspace/image.png' }];
      await client.steerTurn('own-turn', input, 'correction-id');
      const steer = f.calls.find(x => x.method === 'thread-follower-steer-turn');
      assert.equal(steer?.version, 1);
      assert.equal(steer?.targetClientId, 'desktop-owner');
      assert.deepEqual(steer?.params, {
        conversationId: 'desktop-thread', input, clientUserMessageId: 'correction-id',
        restoreMessage: { input, context: {} },
      });
      assert.equal(await client.interruptTurn('own-turn'), true);
      const stop = f.calls.find(x => x.method === 'thread-follower-interrupt-turn');
      assert.equal(stop?.version, 4);
      assert.deepEqual(stop?.params, { conversationId: 'desktop-thread', mode: 'user-stop', expectedTurnId: 'own-turn' });
      assert.equal(f.calls.filter(x => x.method === 'thread-stream-following-changed' && x.params.following).length, 3);
      assert.ok(!f.calls.some(x => ['thread/resume', 'turn/start', 'thread-follower-start-turn', 'thread/queue/add'].includes(x.method)));
    } finally { client.close(); }
    assert.equal(client.connected, false);
  });
});

test('canonical desktop history selects only its current ordered tail, not an older unfinished turn', async () => {
  const state = {
    id: 'desktop-thread', turns: [{ turnId: 'stale-optimistic-turn', status: 'inProgress' }],
    turnHistory: { kind: 'canonical', history: {
      entitiesByKey: {
        old: { turnId: 'old-unfinished', status: 'inProgress' },
        now: { turnId: 'own-turn', status: 'inProgress' },
      },
      islands: [
        { entries: [{ value: 'old' }], newerBoundary: { status: 'available' } },
        { entries: [{ value: 'now' }], newerBoundary: { status: 'exhausted' } },
      ],
    } },
  };
  await fixture(async f => {
    const client = await f.connect();
    assert.ok(client);
    try {
      assert.deepEqual(await client.readState(), { activeTurnId: 'own-turn' });
      await assert.rejects(client.steerTurn('old-unfinished', [{ type: 'text', text: 'Stale' }], 'stale'),
        { code: 'STEER_UNAVAILABLE' });
      assert.ok(!f.calls.some(x => x.method === 'thread-follower-steer-turn'));
    } finally { client.close(); }
  }, { state });
});

test('large desktop snapshots survive fragmented named-pipe/Unix frames without changing owner or sending input', async () => {
  await fixture(async f => {
    const client = await f.connect();
    assert.ok(client);
    try {
      assert.deepEqual(await client.readState(), { activeTurnId: 'own-turn', cwd: '/workspace' });
      assert.equal(client.connected, true);
      assert.ok(!f.calls.some(call => [
        'thread-follower-start-turn', 'thread-follower-steer-turn', 'thread-follower-interrupt-turn',
        'thread/resume', 'thread/queue/add',
      ].includes(call.method)));
    } finally { client.close(); }
  }, {
    timeoutMs: 10_000,
    state: {
      id: 'desktop-thread', cwd: '/workspace',
      turns: [{ turnId: 'own-turn', status: 'inProgress' }],
      // Multi-byte text also exercises UTF-8 boundaries in fragmented frames.
      screenshotHistory: '图'.repeat(6 * 1024 * 1024),
    },
  });
});

test('a late older snapshot cannot replace a more recent owner state when steering', async () => {
  await fixture(async f => {
    const client = await f.connect();
    assert.ok(client);
    try {
      assert.equal((await client.readState()).activeTurnId, 'own-turn');
      await client.steerTurn('own-turn', [{ type: 'text', text: 'Current correction' }], 'current-input');
      assert.equal(f.calls.filter(x => x.method === 'thread-follower-steer-turn').length, 1);
    } finally { client.close(); }
  }, { staleRevision: true });
});

test('idle, changed, malformed and unverified snapshots cannot submit a correction or interrupt', async () => {
  for (const options of [
    { state: { id: 'desktop-thread', turns: [] } },
    { state: { id: 'desktop-thread', turns: [{ turnId: 'own-turn', status: 'completed' }] } },
    { state: { id: 'desktop-thread', turns: [{ turnId: 'later-turn', status: 'inProgress' }] } },
    { state: { id: 'wrong-thread', turns: [] } },
    { state: { id: 'desktop-thread', turns: [null] } },
    { staleSnapshot: true },
  ]) {
    await fixture(async f => {
      const client = await f.connect();
      assert.ok(client);
      try {
        await assert.rejects(client.steerTurn('own-turn', [{ type: 'text', text: 'Must not send' }], 'rejected'));
        assert.ok(!f.calls.some(x => x.method === 'thread-follower-steer-turn'));
        assert.ok(!f.calls.some(x => x.method === 'thread-follower-interrupt-turn'));
      } finally { client.close(); }
    }, options);
  }
});

test('ambiguous desktop steering holds the input for review, never retries or queues it', async () => {
  for (const options of [
    { lostAck: true }, { wrongOwner: true }, { wrongTurn: true }, { noTurnReceipt: true }, { rejectControl: true },
  ]) {
    await fixture(async f => {
      const client = await f.connect();
      assert.ok(client);
      try {
        await assert.rejects(client.steerTurn('own-turn', [{ type: 'text', text: 'Once' }], 'one-id'),
          (error: AnyRecord) => error.code === 'STEER_UNCONFIRMED' && !error.message.includes('PRIVATE_OWNER_ERROR'));
        assert.equal(f.calls.filter(x => x.method === 'thread-follower-steer-turn').length, 1);
        assert.ok(!f.calls.some(x => ['thread-follower-start-turn', 'thread/queue/add', 'turn/start'].includes(x.method)));
      } finally { client.close(); }
    }, options);
  }
});

test('a pinned desktop owner disconnect immediately invalidates controls and pending reads', async () => {
  await fixture(async f => {
    const client = await f.connect();
    assert.ok(client);
    let disconnected = false;
    client.onDisconnect(() => { disconnected = true; });
    try {
      await assert.rejects(client.readState(), { code: 'CODEX_DESKTOP_PEER_DISCONNECTED' });
      assert.equal(client.connected, false);
      assert.equal(disconnected, true);
      await assert.rejects(client.steerTurn('own-turn', [{ type: 'text', text: 'No retry' }], 'disconnected'));
      assert.ok(!f.calls.some(x => x.method === 'thread-follower-steer-turn'));
    } finally { client.close(); }
  }, { ownerDisconnected: true, staleSnapshot: true });
});

test('an unconfirmed Stop never retries against a different desktop turn or owner', async () => {
  for (const options of [
    { lostAck: true }, { wrongOwner: true }, { wrongTurn: true }, { noTurnReceipt: true }, { rejectControl: true },
  ]) {
    await fixture(async f => {
      const client = await f.connect();
      assert.ok(client);
      try {
        await assert.rejects(client.interruptTurn('own-turn'), { code: 'CODEX_DESKTOP_INTERRUPT_UNCONFIRMED' });
        const stops = f.calls.filter(x => x.method === 'thread-follower-interrupt-turn');
        assert.equal(stops.length, 1);
        assert.equal(stops[0].params.expectedTurnId, 'own-turn');
        assert.equal(stops[0].targetClientId, 'desktop-owner');
        assert.ok(!f.calls.some(x => ['thread-follower-start-turn', 'thread/queue/add', 'turn/start'].includes(x.method)));
      } finally { client.close(); }
    }, options);
  }
});
