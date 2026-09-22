import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord, ICodexRpcClient } from '@/shared/index.js';

const THREAD = 'large-native-thread';
const FRAME_LIMIT = 16 * 1024 * 1024;
const PRIVATE_ERROR = 'private-native-error-must-not-escape';

function clientFor(request: ICodexRpcClient['request'], ownsProcess = true): ICodexRpcClient {
  return {
    ownsProcess, request,
    onNotification: () => () => {},
    onServerRequest: () => () => {},
    onDisconnect: () => () => {},
    close: () => {},
  };
}

function unavailable(error: unknown): boolean {
  return error instanceof AppError && error.code === 'CODEX_HISTORY_UNAVAILABLE'
    && !error.message.includes(PRIVATE_ERROR);
}

function smallFixture(
  override?: (method: string, params: AnyRecord) => AnyRecord | undefined,
): { client: ICodexRpcClient; calls: Array<{ method: string; params: AnyRecord }> } {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  return {
    calls,
    client: clientFor(async (method, params) => {
      calls.push({ method, params });
      const custom = override?.(method, params);
      if (custom) return custom;
      if (method === 'thread/read') return { thread: { id: THREAD, turns: [] } };
      if (method === 'thread/loaded/list') return { data: [] };
      if (method === 'thread/turns/list') return {
        data: [{ id: 'turn', itemsView: 'notLoaded', items: [] }], nextCursor: null,
      };
      assert.equal(method, 'thread/items/list', 'Only read-only RPCs are permitted');
      const index = params.cursor === null ? 0 : Number(params.cursor);
      assert.equal(params.turnId, 'turn');
      assert.equal(params.limit, 1);
      return {
        data: [{ turnId: 'turn', item: { id: `item-${index}`, type: 'agentMessage', text: `reply-${index}` } }],
        nextCursor: index === 0 ? '1' : null,
      };
    }),
  };
}

test('native item pagination retains IDs and ordered full items without loading a writer', async () => {
  const f = smallFixture();
  const result = await codexAppServer.readThreadSnapshot(THREAD, { client: f.client });
  assert.deepEqual(result.turns[0].items.map((item: AnyRecord) => item.id), ['item-0', 'item-1']);
  assert.equal(result.turns[0].itemsView, 'full');
  assert.deepEqual(f.calls.map(call => call.method), [
    'thread/read', 'thread/turns/list', 'thread/items/list', 'thread/items/list', 'thread/loaded/list',
  ]);
  assert.ok(f.calls.filter(call => call.method === 'thread/items/list')
    .every(call => call.params.threadId === THREAD && call.params.sortDirection === 'asc'));
});

test('empty native turns and multi-page turn metadata preserve their order', async () => {
  const f = smallFixture((method, params) => {
    if (method === 'thread/turns/list') return {
      data: [{ id: params.cursor ? 'second' : 'first', itemsView: 'notLoaded', items: [] }],
      nextCursor: params.cursor ? null : 'turn-page-2',
    };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
  });
  const result = await codexAppServer.readThreadSnapshot(THREAD, { client: f.client });
  assert.deepEqual(result.turns.map((turn: AnyRecord) => [turn.id, turn.itemsView, turn.items]),
    [['first', 'full', []], ['second', 'full', []]]);
});

for (const fault of [
  'foreign-turn', 'missing-item', 'missing-id', 'missing-type', 'duplicate-item',
  'repeated-cursor', 'missing-cursor', 'empty-advancing-page', 'oversized-page', 'summary-turn',
  'unloaded-with-items', 'rpc-failure', 'unsupported-after-progress',
]) {
  test(`native pagination fails closed on ${fault}, with no full-history or export fallback`, async () => {
    const f = smallFixture((method, params) => {
      if (fault === 'summary-turn' && method === 'thread/turns/list') return {
        data: [{ id: 'turn', itemsView: 'summary', items: [] }], nextCursor: null,
      };
      if (fault === 'unloaded-with-items' && method === 'thread/turns/list') return {
        data: [{ id: 'turn', itemsView: 'notLoaded', items: [{}] }], nextCursor: null,
      };
      if (method !== 'thread/items/list') return;
      const item: AnyRecord = { id: 'item-0', type: 'agentMessage', text: 'reply' };
      const result: AnyRecord = { data: [{ turnId: 'turn', item }], nextCursor: null };
      if (fault === 'foreign-turn') result.data[0].turnId = 'foreign';
      if (fault === 'missing-item') result.data[0].item = null;
      if (fault === 'missing-id') delete item.id;
      if (fault === 'missing-type') delete item.type;
      if (fault === 'duplicate-item') result.nextCursor = params.cursor ? null : '1';
      if (fault === 'repeated-cursor') { item.id = `item-${params.cursor}`; result.nextCursor = '1'; }
      if (fault === 'missing-cursor') delete result.nextCursor;
      if (fault === 'empty-advancing-page') { result.data = []; result.nextCursor = '1'; }
      if (fault === 'oversized-page') result.data.push({ turnId: 'turn', item: { ...item, id: 'extra' } });
      if (fault === 'rpc-failure' || (fault === 'unsupported-after-progress' && params.cursor)) {
        throw new AppError(PRIVATE_ERROR, {
          code: 'CODEX_STDIO_RPC_ERROR', details: { rpcCode: fault === 'rpc-failure' ? -32000 : -32601 },
        });
      }
      if (fault === 'unsupported-after-progress') result.nextCursor = '1';
      return result;
    });
    await assert.rejects(codexAppServer.readThreadSnapshot(THREAD, { client: f.client }), unavailable);
    assert.ok(!f.calls.some(call => call.params.itemsView === 'full' || call.params.includeTurns === true));
  });
}

test('only initial explicit unsupported-item capability permits bounded legacy full-turn reads', async () => {
  const f = smallFixture((method, params) => {
    if (method === 'thread/items/list') throw new AppError(PRIVATE_ERROR, {
      code: 'CODEX_DAEMON_RPC_ERROR', details: { rpcCode: -32601 },
    });
    if (method === 'thread/turns/list' && params.itemsView === 'full') {
      assert.equal(params.limit, 1);
      return {
        data: [{ id: 'turn', itemsView: 'full', items: [{ id: 'legacy', type: 'agentMessage', text: 'legacy reply' }] }],
        nextCursor: null,
      };
    }
  });
  const result = await codexAppServer.readThreadSnapshot(THREAD, { client: f.client });
  assert.equal(result.turns[0].items[0].id, 'legacy');
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 1);
  assert.equal(f.calls.at(-1)?.method, 'thread/loaded/list');
});

test('aggregate snapshot budget and reader ownership checks cannot return partial success', async () => {
  const large = 'x'.repeat(15 * 1024 * 1024);
  const f = smallFixture((method, params) => {
    if (method !== 'thread/items/list') return;
    const index = Number(params.cursor || 0);
    return {
      data: [{ turnId: 'turn', item: { id: `large-${index}`, type: 'agentMessage', text: large } }],
      nextCursor: String(index + 1),
    };
  });
  await assert.rejects(codexAppServer.readThreadSnapshot(THREAD, { client: f.client }), unavailable);
  assert.ok(f.calls.filter(call => call.method === 'thread/items/list').length < 10);
  const loaded = smallFixture(method => method === 'thread/loaded/list' ? { data: [THREAD] } : undefined);
  await assert.rejects(codexAppServer.readThreadSnapshot(THREAD, { client: loaded.client }), unavailable);
});

// The same fixture serves Windows/macOS/Linux stdio and Unix daemon sockets.
// Each turn exceeds 16 MiB; no response may combine even two screenshot items.
const largeServerSource = `
const turnIds = ['older-turn', 'active-turn'];
const payload = 'x'.repeat(1024 * 1024);
function handle(method, params) {
  if (method === 'initialize') return {};
  if (method === 'thread/read') return {thread:{id:'${THREAD}',createdAt:1700000000,turns:[]}};
  if (method === 'thread/loaded/list') return {data:[]};
  if (method === 'thread/turns/list') {
    if(params.itemsView !== 'notLoaded') throw new Error('full turn exceeds frame limit');
    return {data:turnIds.map(id=>({id,items:[],itemsView:'notLoaded',status:'completed'})),nextCursor:null};
  }
  if (method !== 'thread/items/list' || params.limit !== 1 || !turnIds.includes(params.turnId)) {
    throw new Error('unexpected or mutating RPC');
  }
  const i=Number(params.cursor || 0);
  const item={id:params.turnId+'-item-'+i,type:'mcpToolCall',server:'browser',tool:'screenshot',
    status:'completed',arguments:{},result:{content:[{type:'image',data:payload,mimeType:'image/png'}]}};
  return {data:[{turnId:params.turnId,item}],nextCursor:i<19?String(i+1):null};
}
`;

async function withTemporaryDirectory(run: (root: string) => Promise<void>): Promise<void> {
  // /tmp is deliberately short enough for Darwin's Unix socket path limit.
  const parent = process.platform === 'win32' ? path.resolve(os.tmpdir()) : '/tmp';
  const root = await mkdtemp(path.join(parent, 'codey-large-history-'));
  try { await run(root); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('codey-large-history-'));
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyLargeSnapshot(client: ICodexRpcClient): Promise<void> {
  let largestFrame = 0;
  let itemRequests = 0;
  const proxy = clientFor(async (method, params) => {
    const response = await client.request(method, params);
    largestFrame = Math.max(largestFrame, Buffer.byteLength(JSON.stringify(response)));
    if (method === 'thread/items/list') itemRequests++;
    return response;
  }, Boolean(client.ownsProcess));
  const snapshot = await codexAppServer.readThreadSnapshot(THREAD, { client: proxy });
  assert.deepEqual(snapshot.turns.map((turn: AnyRecord) => turn.id), ['older-turn', 'active-turn']);
  for (const turn of snapshot.turns) {
    assert.equal(turn.items.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(turn)) > FRAME_LIMIT);
    assert.deepEqual(turn.items.map((item: AnyRecord) => item.id),
      Array.from({ length: 20 }, (_, index) => `${turn.id}-item-${index}`));
  }
  assert.equal(itemRequests, 40);
  assert.ok(largestFrame < FRAME_LIMIT);
}

test('real stdio transport reads a 40 MiB history on Windows, Linux and macOS without enlarging its frame limit', async () => {
  await withTemporaryDirectory(async root => {
    const script = path.join(root, 'native-fixture.cjs');
    await writeFile(script, largeServerSource + `
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);if(r.id===undefined)return;
  try{process.stdout.write(JSON.stringify({id:r.id,result:handle(r.method,r.params)})+'\\n');}
  catch(e){process.stdout.write(JSON.stringify({id:r.id,error:{code:-32000,message:e.message}})+'\\n');}
});`);
    const client = await CodexStdioClient.connect({
      executable: process.execPath, launcherArgs: [script], home: root, timeoutMs: 10_000,
    });
    try { await verifyLargeSnapshot(client); }
    finally { await client.close(); }
  });
});

test('real Linux/macOS Unix daemon transport uses the same bounded large-history reader',
  { skip: process.platform === 'win32' }, async () => {
    await withTemporaryDirectory(async root => {
      const fixtureModule = path.join(root, 'native-fixture.cjs');
      await writeFile(fixtureModule, largeServerSource + '\nmodule.exports = handle;');
      const { createRequire } = await import('node:module');
      const handle = createRequire(import.meta.url)(fixtureModule) as (method: string, params: AnyRecord) => AnyRecord;
      const server = http.createServer();
      const sockets = new WebSocketServer({ server, perMessageDeflate: false });
      const endpoint = path.join(root, 'backend.sock');
      sockets.on('connection', socket => socket.on('message', raw => {
        const request = JSON.parse(String(raw));
        if (request.id === undefined) return;
        try { socket.send(JSON.stringify({ id: request.id, result: handle(request.method, request.params) })); }
        catch { socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: PRIVATE_ERROR } })); }
      }));
      server.listen(endpoint);
      await once(server, 'listening');
      let client: ICodexRpcClient | null = null;
      try {
        client = await CodexDaemonClient.connect({ socketPath: endpoint });
        assert.ok(client);
        await verifyLargeSnapshot(client);
      } finally {
        await client?.close();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });
