import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { WebSocketServer } from 'ws';

import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { connectCodexNativeClient } from '@/modules/providers/list/codex/codex-native-client.service.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';

const envKeys = [
  'CODEX_HOME', 'CODEY_CODEX_EXECUTABLE', 'CODEY_CODEX_DAEMON_SOCKET', 'CODEY_CODEX_RUNTIME_TRANSPORT',
] as const;
const unixOnly = { skip: process.platform === 'win32', concurrency: false };

async function withSocketOwner(
  t: TestContext,
  run: (fixture: { root: string; home: string; alias: string; target: string; methods: string[] }) => Promise<void>,
  rejectInitialize = false,
): Promise<void> {
  // Keep even the default endpoint below Darwin's Unix-socket pathname limit.
  const root = await fs.mkdtemp('/tmp/codey-sock-');
  const home = path.join(root, 'home');
  const alias = path.join(home, 'app-server-control', 'app-server-control.sock');
  const target = path.join(root, 'owner.sock');
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const server = http.createServer();
  const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  const methods: string[] = [];
  const fallback = t.mock.method(CodexStdioClient, 'connect', async () => {
    throw new Error('Socket discovery unexpectedly started another native backend');
  });
  try {
    for (const key of envKeys) delete process.env[key];
    process.env.CODEX_HOME = home;
    process.env.CODEY_CODEX_EXECUTABLE = '/configured/codex';
    await fs.mkdir(path.dirname(alias), { recursive: true });
    sockets.on('connection', socket => {
      socket.on('message', raw => {
        const request = JSON.parse(String(raw));
        methods.push(request.method);
        if (request.id === undefined) return;
        if (request.method === 'initialize' && rejectInitialize) {
          socket.send(JSON.stringify({
            id: request.id, error: { code: -32000, message: 'Incompatible test owner' },
          }));
        } else {
          socket.send(JSON.stringify({
            id: request.id,
            result: request.method === 'initialize' ? { codexHome: home } : { data: [] },
          }));
        }
      });
    });
    server.listen(target);
    await once(server, 'listening');
    await run({ root, home, alias, target, methods });
    assert.equal(fallback.mock.callCount(), 0, 'an existing owner never selects a second backend');
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const link of ['absolute', 'relative', 'chain'] as const) {
  for (const explicit of [false, true]) {
    test(`${explicit ? 'explicit' : 'default'} daemon follows a ${link} socket symlink`, unixOnly, async t => {
      await withSocketOwner(t, async ({ root, alias, target, methods }) => {
        let destination = target;
        if (link === 'relative') destination = path.relative(path.dirname(alias), target);
        if (link === 'chain') {
          destination = path.join(root, 'owner-link.sock');
          await fs.symlink(target, destination);
        }
        await fs.symlink(destination, alias);
        assert.ok((await fs.lstat(alias)).isSymbolicLink(), 'the fixture must exercise a symlink');
        if (explicit) process.env.CODEY_CODEX_DAEMON_SOCKET = alias;

        const client = await connectCodexNativeClient();
        try {
          assert.ok(client instanceof CodexDaemonClient);
          assert.deepEqual(await client.request('thread/list', {}), { data: [] });
          assert.deepEqual(methods, ['initialize', 'initialized', 'thread/list']);
        } finally {
          await client?.close();
        }
      });
    });
  }
}

for (const destination of ['missing', 'file', 'directory'] as const) {
  test(`${destination} symlink target preserves default fallback and explicit-owner rejection`, unixOnly, async t => {
    await withSocketOwner(t, async ({ root, home, alias }) => {
      const target = path.join(root, 'not-a-socket');
      if (destination === 'file') await fs.writeFile(target, 'not a socket');
      if (destination === 'directory') await fs.mkdir(target);
      await fs.symlink(target, alias);

      assert.equal(await CodexDaemonClient.connect({ home }), null);
      process.env.CODEY_CODEX_DAEMON_SOCKET = alias;
      await assert.rejects(connectCodexNativeClient(), { code: 'CODEX_DAEMON_UNAVAILABLE' });
    });
  });
}

test('socket symlink loops fail closed for both default and explicit owners', unixOnly, async t => {
  await withSocketOwner(t, async ({ alias }) => {
    await fs.symlink(alias, alias);
    await assert.rejects(connectCodexNativeClient(), { code: 'ELOOP' });
    process.env.CODEY_CODEX_DAEMON_SOCKET = alias;
    await assert.rejects(connectCodexNativeClient(), { code: 'ELOOP' });
  });
});

for (const explicit of [false, true]) {
  test(`${explicit ? 'explicit' : 'default'} linked owner handshake failures never start another backend`, unixOnly, async t => {
    await withSocketOwner(t, async ({ alias, target, methods }) => {
      await fs.symlink(target, alias);
      if (explicit) process.env.CODEY_CODEX_DAEMON_SOCKET = alias;
      await assert.rejects(connectCodexNativeClient(), { code: 'CODEX_DAEMON_RPC_ERROR' });
      assert.deepEqual(methods, ['initialize'], 'failed requests are not retried');
    }, true);
  });
}
