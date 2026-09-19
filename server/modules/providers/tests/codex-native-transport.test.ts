import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { connectCodexNativeClient } from '@/modules/providers/list/codex/codex-native-client.service.js';

const envKeys = ['CODEY_CODEX_EXECUTABLE', 'CODEY_CODEX_DAEMON_SOCKET', 'CODEY_CODEX_RUNTIME_TRANSPORT'] as const;

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform}: native backend selection is capability-based, owner-first and fail-closed`, { concurrency: false }, async t => {
    const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const owner = {} as CodexDaemonClient;
    const native = { ownsProcess: true } as CodexStdioClient;
    const calls: string[] = [];
    let available: CodexDaemonClient | null = owner;
    let ownerError: Error | null = null;
    let nativeError: Error | null = null;
    t.mock.method(CodexDaemonClient, 'connect', async () => {
      calls.push('owner');
      if (ownerError) throw ownerError;
      return available;
    });
    t.mock.method(CodexStdioClient, 'connect', async () => {
      calls.push('stdio');
      if (nativeError) throw nativeError;
      return native;
    });
    try {
      for (const key of envKeys) delete process.env[key];
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
      process.env.CODEY_CODEX_EXECUTABLE = '/configured/codex';
      assert.equal(await connectCodexNativeClient(), owner);
      assert.deepEqual(calls.splice(0), ['owner']);

      available = null;
      assert.equal(await connectCodexNativeClient(), native);
      assert.deepEqual(calls.splice(0), ['owner', 'stdio']);

      delete process.env.CODEY_CODEX_EXECUTABLE;
      assert.equal(await connectCodexNativeClient(), null);
      assert.deepEqual(calls.splice(0), ['owner']);

      process.env.CODEY_CODEX_RUNTIME_TRANSPORT = 'stdio';
      assert.equal(await connectCodexNativeClient(), native);
      assert.deepEqual(calls.splice(0), ['stdio']);

      process.env.CODEY_CODEX_DAEMON_SOCKET = '/explicit/backend.sock';
      await assert.rejects(connectCodexNativeClient(), { code: 'CODEX_RUNTIME_TRANSPORT_INVALID' });
      assert.deepEqual(calls.splice(0), []);
      process.env.CODEY_CODEX_DAEMON_SOCKET = '';
      process.env.CODEY_CODEX_RUNTIME_TRANSPORT = 'unexpected-transport';
      await assert.rejects(connectCodexNativeClient(), { code: 'CODEX_RUNTIME_TRANSPORT_INVALID' });
      assert.deepEqual(calls.splice(0), []);

      process.env.CODEY_CODEX_RUNTIME_TRANSPORT = '';
      process.env.CODEY_CODEX_EXECUTABLE = '/configured/codex';
      ownerError = new Error('Explicit socket unavailable or incompatible daemon');
      await assert.rejects(connectCodexNativeClient(), ownerError);
      assert.deepEqual(calls.splice(0), ['owner'], 'never fall back after a failed owner connection');
      ownerError = null;
      nativeError = new Error('Native handshake failed');
      await assert.rejects(connectCodexNativeClient(), nativeError);
      assert.deepEqual(calls.splice(0), ['owner', 'stdio'], 'never choose another executable after a native failure');
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      for (const key of envKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
}
