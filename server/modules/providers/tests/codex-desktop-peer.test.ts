import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexDesktopPeerClient } from '@/modules/providers/list/codex/codex-desktop-peer.client.js';
import type { AnyRecord } from '@/shared/index.js';

async function fixture(
  body: (f: { home: string; endpoint: string; calls: AnyRecord[]; connect: () => Promise<CodexDesktopPeerClient | null> }) => Promise<void>,
  options: { noOwner?: boolean; rejectStart?: boolean; lostAck?: boolean; wrongOwner?: boolean; invalidHandshake?: boolean; invalidFrame?: boolean } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codey-desktop-peer-'));
  const directory = path.join(home, 'ipc');
  const endpoint = path.join(directory, 'ipc.sock');
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
    socket.on('data', data => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE(0);
        if (buffered.length < size + 4) return;
        const message = JSON.parse(buffered.subarray(4, size + 4).toString('utf8')) as AnyRecord;
        buffered = buffered.subarray(size + 4);
        calls.push(message);
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
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(endpoint, resolve);
    });
    await body({ home, endpoint, calls, connect: () => CodexDesktopPeerClient.connect('desktop-thread', { home, timeoutMs: 500 }) });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
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

test('untrusted or linked peer directories are refused before connecting', async () => {
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

test('a regular file cannot impersonate the desktop peer socket', async () => {
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

test('Linux and macOS use the CODEX_HOME-scoped IPC endpoint', async () => {
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
