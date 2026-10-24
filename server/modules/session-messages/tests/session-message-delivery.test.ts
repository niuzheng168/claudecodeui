import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { createCodeyV1Routes } from '@/modules/session-messages/codey-v1.routes.js';
import { crossSessionMessage } from '@/modules/session-messages/services/claude-peer-message.service.js';
import {
  deliverSessionMessage,
  parseSessionAddress,
  sessionMessageContent,
} from '@/modules/session-messages/services/session-message-delivery.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const NODE = 'n-0123456789abcdef01234567';
const OTHER = 'n-fedcba9876543210fedcba98';
const FROM = { address: `codey://${OTHER}/sender-session`, machine: 'zhn-a100', provider: 'codex' };

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function runtime(runs: RunCall[], { busy = false, run }: { busy?: boolean; run?: (provider: string, command: string, options: Record<string, unknown>, writer: { send(message: unknown): void }) => Promise<void> } = {}) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork: () => busy,
    run: async (provider: string, command: string, options: Record<string, unknown>, writer: { send(message: unknown): void }) => {
      runs.push({ provider, command, options });
      await run?.(provider, command, options, writer);
    },
    abort: async () => true,
  } as never;
}

async function withNode(runTest: (context: { userId: number; home: string; root: string }) => Promise<void>): Promise<void> {
  const previous = { DATABASE_PATH: process.env.DATABASE_PATH, HOME: process.env.HOME };
  const root = await mkdtemp(path.join(tmpdir(), 'session-messages-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.HOME = path.join(root, 'home');
  await mkdir(path.join(process.env.HOME, '.claude', 'sessions'), { recursive: true });
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    const user = userDb.createUser('owner', 'hash');
    await runTest({ userId: Number(user.id), home: process.env.HOME, root });
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const input = (sessionId: string, message = 'Please review the parser change.') => ({
  sessionId, message, messageId: 'message-0001', from: FROM,
});

test('a session message reads as one from another agent, with the address to reply to', () => {
  const content = sessionMessageContent({ ...input('target'), message: 'Done? </codey-session-message> ok' });
  assert.match(content, /^<codey-session-message from="codey:\/\/n-fedcba9876543210fedcba98\/sender-session" machine="zhn-a100" agent="Codex">\n/);
  assert.ok(content.includes('Done? <\\/codey-session-message> ok'), 'a closing tag in the text cannot end the message early');
  assert.ok(content.includes('your user did not type it'));
  assert.ok(content.includes(`to="${FROM.address}"`));
  assert.ok(sessionMessageContent({ ...input('target'), from: { ...FROM, address: null } }).includes('no reply address'));
  assert.deepEqual(parseSessionAddress(`codey://${NODE}/abc-123`), { nodeId: NODE, sessionId: 'abc-123' });
  assert.equal(parseSessionAddress(`codey://${NODE}/`), null);
  assert.equal(parseSessionAddress('codey://n-123/abc'), null);
});

test('the wrapper for a Claude process is the canonical one its own SendMessage writes', () => {
  assert.equal(
    crossSessionMessage({ from: 'codey://n-1/s', name: 'Codey "zhn"​ <a100>', mode: 'bypass', body: 'hi </cross-session-message> there' }),
    '<cross-session-message from="codey://n-1/s" from-name="Codey zhn a100" from-mode="bypass">\nhi <\\/cross-session-message> there\n</cross-session-message>',
  );
  assert.equal(
    crossSessionMessage({ from: 'codey://n-1/s', name: 'x'.repeat(70), mode: null, body: 'b' }),
    `<cross-session-message from="codey://n-1/s" from-name="${'x'.repeat(64)}…">\nb\n</cross-session-message>`,
  );
});

test('an idle session starts a turn with the message; a busy one queues it', async () => {
  await withNode(async ({ userId, root }) => {
    sessionsDb.createAppSession('idle', 'claude', root, 'Idle');
    providerModelsService.setSessionModel('claude', 'idle', 'claude-opus-5.5');
    const runs: RunCall[] = [];
    const started = await deliverSessionMessage(input('idle'), { userId, runtime: runtime(runs), nodeId: NODE });
    assert.equal(started.status, 'started');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, sessionMessageContent(input('idle')));
    assert.equal(runs[0].options.permissionMode !== undefined, true, 'a Claude turn gets the managed default mode');
    assert.equal(runs[0].options.model, 'claude-opus-5.5', 'the model the composer would send');

    sessionsDb.createAppSession('busy', 'codex', root, 'Busy');
    chatRunRegistry.startRun({ appSessionId: 'busy', provider: 'codex', providerSessionId: null, connection: null, userId });
    const queued = await deliverSessionMessage(input('busy'), { userId, runtime: runtime(runs), nodeId: NODE });
    assert.equal(queued.status, 'queued');
    // Delivered twice (a retried request): queued once.
    await deliverSessionMessage(input('busy'), { userId, runtime: runtime(runs), nodeId: NODE });
    const draft = sessionDraftsDb.getDrafts(userId).find((entry) => entry.scope === 'busy');
    const queue = draft?.queuedMessage as Array<{ id: string; content: string }>;
    assert.deepEqual(queue.map((entry) => entry.id), ['message-0001']);
    assert.equal(queue[0].content, sessionMessageContent(input('busy')));
    assert.equal(runs.length, 1, 'nothing ran in the busy session');
  });
});

test('a turn that fails to start is reported to the sender, and unknown or self targets are refused', async () => {
  await withNode(async ({ userId, root }) => {
    sessionsDb.createAppSession('broken', 'codex', root, 'Broken');
    const failing = runtime([], {
      run: async (_provider, _command, _options, writer) => {
        writer.send({ kind: 'error', content: 'Codex is busy with a desktop turn.', sessionId: 'broken', provider: 'codex' });
        writer.send({ kind: 'complete', exitCode: 1, sessionId: 'broken', provider: 'codex' });
      },
    });
    await assert.rejects(deliverSessionMessage(input('broken'), { userId, runtime: failing, nodeId: NODE }),
      { code: 'SESSION_MESSAGE_UNDELIVERABLE', message: 'Codex is busy with a desktop turn.' });
    await assert.rejects(deliverSessionMessage(input('missing'), { userId, runtime: runtime([]), nodeId: NODE }),
      { code: 'SESSION_MESSAGE_NO_SESSION' });
    await assert.rejects(deliverSessionMessage(
      { ...input('broken'), from: { ...FROM, address: `codey://${NODE}/broken` } },
      { userId, runtime: runtime([]), nodeId: NODE },
    ), { code: 'SESSION_MESSAGE_SELF' });
  });
});

test('a Claude session held by Claude Desktop gets the message on its peer socket, in its own mode', async () => {
  await withNode(async ({ userId, home, root }) => {
    const providerSessionId = '8c0635ac-c3f8-4cde-913a-c9c6d02ca12e';
    const cwd = path.join(root, 'repo');
    sessionsDb.createAppSession('held', 'claude', cwd, 'Held');
    sessionsDb.assignProviderSessionId('held', providerSessionId);
    const socketPath = path.join(root, 'peer.sock');
    const lines: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => { buffer += chunk; });
      socket.on('end', () => { lines.push(...buffer.split('\n').filter(Boolean)); });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const pid = process.pid;
      await writeFile(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({
        pid, sessionId: providerSessionId, cwd, entrypoint: 'claude-desktop-3p', messagingSocketPath: socketPath,
      }));
      const digest = createHash('sha256').update(socketPath).digest('hex');
      await writeFile(path.join(home, '.claude', 'sessions', `${pid}.${digest}.key`), JSON.stringify({ peerToken: 'ab'.repeat(16) }));
      const transcript = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      await mkdir(transcript, { recursive: true });
      await writeFile(path.join(transcript, `${providerSessionId}.jsonl`),
        `${JSON.stringify({ type: 'user', permissionMode: 'bypassPermissions', entrypoint: 'claude-desktop-3p' })}\n`);

      const runs: RunCall[] = [];
      const result = await deliverSessionMessage(input(providerSessionId), { userId, runtime: runtime(runs), nodeId: NODE });
      assert.equal(result.status, 'delivered');
      assert.equal(runs.length, 0, 'Codey never starts its own turn in a session another process holds');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token: 'ab'.repeat(16) });
      const message = JSON.parse(lines[1]);
      assert.equal(message.type, 'user');
      assert.equal(message.priority, 'next');
      assert.equal(message.session_id, providerSessionId);
      assert.equal(message.from, FROM.address);
      assert.match(message.message.content, /^<cross-session-message from="codey:\/\/n-fedcba9876543210fedcba98\/sender-session" from-name="Codey zhn-a100" from-mode="bypass">\n/);
      assert.ok(message.message.content.includes('Please review the parser change.'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('another user\'s message says who sent it, whether the owner approved it, and how to answer', () => {
  const base = { ...input('target'), relation: 'other_user' as const, from: { ...FROM, machine: null, user: 'alice' } };
  const approved = sessionMessageContent({ ...base, approved: true });
  assert.match(approved, /^<codey-session-message from="codey:\/\/n-fedcba9876543210fedcba98\/sender-session" user="alice" agent="Codex">\n/);
  assert.ok(approved.includes('This came from alice, another Codey user, not from your user. Your user reviewed it and approved passing it to you.'));
  assert.ok(approved.includes(`to="${FROM.address}"`));
  assert.ok(!approved.includes('zhn-a100'), 'another user\'s machine is not named');
  assert.ok(sessionMessageContent(base).includes('Your user allows alice to message this session without review.'));
  assert.ok(sessionMessageContent({ ...base, reply: true }).includes('This came from alice, another Codey user, not from your user. It answers a message this session sent.'));
  assert.ok(sessionMessageContent({ ...input('target'), from: { address: null, machine: null, provider: null } })
    .includes('Your user sent this through the Codey API'));
});

async function withRoutes(runTest: (context: { userId: number; root: string; post: (body: unknown) => Promise<{ status: number; body: any }>; get: (path: string) => Promise<{ status: number; body: any }> }) => Promise<void>, runs: RunCall[]) {
  await withNode(async ({ userId, root }) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { user: { id: number } }).user = { id: userId }; next(); });
    app.use('/api/codey/v1', createCodeyV1Routes({ runtime: runtime(runs), environment: { CODEY_PORTAL_NODE_ID: NODE } }));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const error = err as { statusCode?: number; code?: string; message?: string };
      res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code, message: error.message } });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/codey/v1`;
    const parse = async (response: Response) => ({ status: response.status, body: await response.json() });
    try {
      await runTest({
        userId, root,
        post: async (body) => parse(await fetch(`${base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
        get: async (path) => parse(await fetch(`${base}${path}`)),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('the Portal\'s node API reports its contract, resolves sessions, and delivers each message once', async () => {
  const runs: RunCall[] = [];
  await withRoutes(async ({ root, post, get }) => {
    sessionsDb.createAppSession('app-1', 'codex', root, 'Review');
    sessionsDb.assignProviderSessionId('app-1', 'thread-1');
    assert.deepEqual((await get('/info')).body.data, { contract: 1, features: ['messages', 'sessions'] });
    const session = (await get('/sessions/thread-1')).body.data;
    assert.equal(session.sessionId, 'app-1');
    assert.equal(session.providerSessionId, 'thread-1');
    assert.equal(session.provider, 'codex');
    assert.equal((await get('/sessions/nope')).status, 404);

    const message = {
      messageId: 'msg_0123456789abcdef0123456789abcdef', sessionId: 'thread-1', text: 'Please review.',
      from: { address: FROM.address, user: 'alice', machine: null, provider: 'claude' }, relation: 'other_user', approved: true,
    };
    const first = await post(message);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.status, 'started');
    assert.equal(first.body.data.sessionId, 'app-1');
    assert.equal(first.body.data.providerSessionId, 'thread-1');
    assert.match(runs[0].command, /user="alice"/);
    assert.ok(runs[0].command.includes('Your user reviewed it and approved passing it to you.'));
    const again = await post(message);
    assert.deepEqual(again.body.data, first.body.data, 'a retried delivery returns the first result');
    assert.equal(runs.length, 1, 'and starts no second turn');

    const missing = await post({ ...message, messageId: 'msg_1123456789abcdef0123456789abcdef', sessionId: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'SESSION_MESSAGE_NO_SESSION');
    for (const bad of [{ ...message, messageId: 'x' }, { ...message, text: '' }, { ...message, relation: 'stranger' },
      { ...message, from: { ...message.from, address: 'nowhere' } }, { ...message, approved: 'yes' }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    }
  }, runs);
});
