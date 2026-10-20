import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AnyRecord } from '@/shared/index.js';

import { createCommandsRouter } from '../commands.routes.js';

async function withRouter(
  claudeNativeCommands: (() => Promise<Array<{ name: string; description: string }>>) | undefined,
  run: (post: (route: string, body: unknown) => Promise<AnyRecord>) => Promise<void>,
): Promise<void> {
  const missing = async () => { throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); };
  const router = createCommandsRouter({
    fileSystem: { access: missing } as never, homeDirectory: () => '/fixture',
    appRoot: '/fixture', models: {} as never, claudeNativeCommands,
    runtime: { uptime: () => 0, memoryUsage: () => ({} as NodeJS.MemoryUsage), version: 'test', platform: 'linux', pid: 1 },
  });
  const server = express().use(express.json()).use(router).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<AnyRecord>;
    });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

const builtInNames = (result: AnyRecord) => result.builtIn.map((command: { name: string }) => command.name);

test('Claude chats list Claude Code\'s own commands after Codey\'s, and other providers do not', async () => {
  let calls = 0;
  const discovered = async () => {
    calls += 1;
    return [
      { name: '/compact', description: 'Free up context by summarizing the conversation so far' },
      // Codey's built-ins keep these names, and /goal stays the Codex command.
      { name: '/cost', description: 'Claude Code cost' },
      { name: '/status', description: 'Claude Code status' },
      { name: '/goal', description: 'Claude Code goal' },
    ];
  };

  await withRouter(discovered, async (post) => {
    const claude = await post('/list', { provider: 'claude' });
    assert.deepEqual(builtInNames(claude), ['/help', '/models', '/cost', '/memory', '/config', '/status', '/compact']);
    assert.deepEqual(claude.builtIn.at(-1), {
      name: '/compact',
      description: 'Free up context by summarizing the conversation so far',
      namespace: 'builtin',
      metadata: { type: 'native', provider: 'claude' },
    });
    assert.equal(claude.builtIn.find((command: AnyRecord) => command.name === '/cost').metadata.type, 'builtin');

    for (const provider of ['codex', 'cursor', 'opencode']) {
      const result = await post('/list', { provider });
      assert.equal(result.builtIn.some((command: AnyRecord) => command.metadata?.provider === 'claude'), false, provider);
    }
    assert.equal(calls, 1, 'only a Claude chat asks for Claude Code commands');

    const help = await post('/execute', { commandName: '/help', context: { provider: 'claude' } });
    assert.match(help.data.content, /### \/compact\nFree up context/);
  });
});

test('Codey\'s built-ins are still listed when Claude Code command discovery fails', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failing = async () => { throw new Error('claude not installed'); };

  for (const source of [failing, undefined]) {
    await withRouter(source, async (post) => {
      const claude = await post('/list', { provider: 'claude' });
      assert.deepEqual(builtInNames(claude), ['/help', '/models', '/cost', '/memory', '/config', '/status']);
    });
  }
});
