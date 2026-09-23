import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';

const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;

function createClient(t: TestContext) {
  const stdout = new PassThrough();
  const stdin = new Writable({ write: (_chunk, _encoding, done) => done() });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => {
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return true;
    },
  });
  stdin.on('finish', () => child.kill());

  // Inject pipes with deterministic chunk boundaries without starting Codex or
  // touching native history. Production connects through the existing factory.
  const client = Reflect.construct(CodexStdioClient, [child, 30_000]) as CodexStdioClient;
  t.after(() => client.close());
  return { client, stdout };
}

test('large fragmented history is assembled without repeatedly measuring the accumulated text', async (t) => {
  const { client, stdout } = createClient(t);
  const text = '更早的消息🙂'.repeat(200_000);
  const frame = Buffer.from(`${JSON.stringify({ id: 1, result: { text } })}\n`);
  const reply = client.request('thread/turns/list', { threadId: 'large-history' });
  const byteLength = Buffer.byteLength;
  let measuredCharacters = 0;
  t.mock.method(Buffer, 'byteLength', (...args: Parameters<typeof Buffer.byteLength>) => {
    if (typeof args[0] === 'string') measuredCharacters += args[0].length;
    return byteLength(...args);
  });

  for (let start = 0; start < frame.length; start += 4093) {
    stdout.write(frame.subarray(start, start + 4093));
  }

  assert.equal((await reply).text, text);
  assert.ok(
    measuredCharacters <= frame.length * 2,
    `framing must do linear work, not rescan ${measuredCharacters} characters for ${frame.length} bytes`,
  );
});

test('fragmented UTF-8, CRLF, notifications and out-of-order replies keep their framing', async (t) => {
  const { client, stdout } = createClient(t);
  const first = client.request('first', {});
  const second = client.request('second', {});
  const notifications: unknown[] = [];
  client.onNotification((method, params) => notifications.push({ method, params }));
  const frame = Buffer.from([
    '',
    'not json',
    JSON.stringify({ id: 2, result: { text: '更早🙂' } }),
    JSON.stringify({ method: 'item/completed', params: { text: '消息✅' } }),
    JSON.stringify({ id: 1, result: { text: '第一页' } }),
    '',
  ].join('\r\n'));

  // Splits every multibyte character across pipe reads.
  for (const byte of frame) stdout.write(Buffer.from([byte]));

  assert.deepEqual(await first, { text: '第一页' });
  assert.deepEqual(await second, { text: '更早🙂' });
  assert.deepEqual(notifications, [{ method: 'item/completed', params: { text: '消息✅' } }]);
});

test('the size limit applies to each frame, not multiple frames delivered in one chunk', async (t) => {
  const { client, stdout } = createClient(t);
  const text = 'x'.repeat(9 * 1024 * 1024);
  const replies = Promise.all([client.request('first', {}), client.request('second', {})]);
  const frame = Buffer.from([1, 2].map(id => JSON.stringify({ id, result: { text } })).join('\n') + '\n');
  assert.ok(frame.length > FRAME_LIMIT_BYTES);

  stdout.write(frame);

  for (const reply of await replies) assert.equal(reply.text.length, text.length);
});

test('a frame exactly at the limit accepts a separately delivered newline', async (t) => {
  const { client, stdout } = createClient(t);
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ id: 1, result: { text: '' } }));
  const text = 'x'.repeat(FRAME_LIMIT_BYTES - envelopeBytes);
  const frame = Buffer.from(JSON.stringify({ id: 1, result: { text } }));
  const reply = client.request('at-limit', {});
  assert.equal(frame.length, FRAME_LIMIT_BYTES);

  stdout.write(frame);
  stdout.write(Buffer.from('\n'));

  assert.equal((await reply).text.length, text.length);
});

test('oversized UTF-8 frames fail once and do not dispatch later buffered events', async (t) => {
  const { client, stdout } = createClient(t);
  const notifications: string[] = [];
  const disconnections: Error[] = [];
  client.onNotification(method => notifications.push(method));
  client.onDisconnect(error => disconnections.push(error));
  const rejection = assert.rejects(client.request('oversized', {}), { code: 'CODEX_STDIO_PROTOCOL_ERROR' });
  const text = '中'.repeat(Math.ceil(FRAME_LIMIT_BYTES / 3));
  assert.ok(text.length < FRAME_LIMIT_BYTES);
  const frame = Buffer.from(`${JSON.stringify({ id: 1, result: { text } })}\n`);
  for (let start = 0; start < frame.length; start += 65_536) {
    stdout.write(frame.subarray(start, start + 65_536));
  }
  stdout.write(Buffer.from(`${JSON.stringify({ method: 'must-not-dispatch', params: {} })}\n`));

  await rejection;
  assert.equal(disconnections.length, 1);
  assert.deepEqual(notifications, []);
});
