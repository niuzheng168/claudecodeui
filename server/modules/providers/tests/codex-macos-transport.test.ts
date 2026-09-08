import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';

test('an explicitly configured Mac backend fails closed instead of using another socket or exec', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codey-explicit-socket-'));
  try {
    await assert.rejects(CodexDaemonClient.connect({ socketPath: 'relative.sock' }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_DAEMON_UNAVAILABLE');
    await assert.rejects(CodexDaemonClient.connect({ socketPath: path.join(home, 'missing.sock') }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_DAEMON_UNAVAILABLE');
    await writeFile(path.join(home, 'not-a-socket'), 'not a server');
    await assert.rejects(CodexDaemonClient.connect({ socketPath: path.join(home, 'not-a-socket') }),
      (error: unknown) => (error as { code?: string }).code === 'CODEX_DAEMON_UNAVAILABLE');
    assert.equal(await CodexDaemonClient.connect({ home }), null, 'Unconfigured legacy installations retain their existing fallback');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a Mac node can use its own Unix backend without changing the default Codex socket',
  { skip: process.platform === 'win32' }, async () => {
    // Use /tmp directly to stay below Darwin's Unix-socket pathname limit.
    const home = await mkdtemp('/tmp/codey-own-');
    const socketPath = path.join(home, 'backend.sock');
    const server = http.createServer();
    const sockets = new WebSocketServer({ server, perMessageDeflate: false });
    const methods: string[] = [];
    sockets.on('connection', socket => {
      socket.on('message', raw => {
        const request = JSON.parse(String(raw));
        methods.push(request.method);
        if (request.id !== undefined) {
          socket.send(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : { data: [] } }));
        }
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    let client: CodexDaemonClient | null = null;
    try {
      client = await CodexDaemonClient.connect({ socketPath });
      assert.ok(client);
      assert.deepEqual(await client.request('thread/list', {}), { data: [] });
      assert.deepEqual(methods, ['initialize', 'initialized', 'thread/list']);
      assert.equal(await CodexDaemonClient.connect({ home }), null);
    } finally {
      client?.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
