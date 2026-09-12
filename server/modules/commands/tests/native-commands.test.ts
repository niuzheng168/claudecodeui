import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/index.js';

import { createCommandsRouter } from '../commands.routes.js';
import { createNativeCommandsRouter } from '../native-commands.routes.js';

test('goal controls validate input and retain native failures without accepting arbitrary RPC methods', async () => {
  const calls: unknown[] = [];
  const app = express().use(express.json()).use(createNativeCommandsRouter(async (id, text) => {
    calls.push([id, text]);
    if (text === 'pause') throw new AppError('Owner unavailable', { code: 'CODEX_DAEMON_REQUIRED', statusCode: 409 });
    return { goal: null, message: 'No goal' };
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/goal`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const body of [{}, { arguments: [] }, { arguments: '', sessionId: {} }, { arguments: 'x'.repeat(20001) }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal(calls.length, 0);
    assert.equal((await post({ arguments: '', sessionId: null })).status, 200);
    const failure = await post({ arguments: 'pause', sessionId: 'app' });
    assert.equal(failure.status, 409);
    assert.equal((await failure.json() as AnyRecord).code, 'CODEX_DAEMON_REQUIRED');
    assert.deepEqual(calls, [[null, ''], ['app', 'pause']]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('native goal/plan command catalog is provider-scoped and included in Codex help', async () => {
  const missing = async () => { throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); };
  const router = createCommandsRouter({
    fileSystem: { access: missing } as never, homeDirectory: () => '/fixture',
    appRoot: '/fixture', models: {} as never,
    runtime: { uptime: () => 0, memoryUsage: () => ({} as NodeJS.MemoryUsage), version: 'test', platform: 'linux', pid: 1 },
  });
  const server = express().use(express.json()).use(router).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<AnyRecord>;
    };
    for (const provider of ['codex', 'claude', 'cursor']) {
      const result = await post('/list', { provider });
      for (const name of ['/goal', '/plan']) {
        const command = result.builtIn.find((entry: { name: string }) => entry.name === name);
        assert.equal(Boolean(command), provider === 'codex');
        if (command) assert.deepEqual(command.metadata, { type: 'native', provider: 'codex' });
      }
    }
    const help = await post('/execute', { commandName: '/help', context: { provider: 'codex' } });
    assert.match(help.data.content, /^# Codex Commands/);
    assert.match(help.data.content, /\/goal/);
    assert.match(help.data.content, /\/plan/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
