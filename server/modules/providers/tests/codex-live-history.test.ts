import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexNativeQueueRun } from '@/modules/providers/list/codex/codex-native-queue.service.js';
import { CodexNativeTurnReader } from '@/modules/providers/list/codex/codex-native-turns.service.js';
import { CodexStdioClient } from '@/modules/providers/list/codex/codex-stdio.client.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord, ICodexRpcClient } from '@/shared/index.js';

function fixture(override?: (method: string, params: AnyRecord) => AnyRecord | undefined) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const emitted: string[] = [];
  const client: ICodexRpcClient = {
    ownsProcess: true,
    async request(method, params) {
      calls.push({ method, params });
      const result = override?.(method, params);
      if (result) return result;
      if (method === 'thread/read') return { thread: { id: 'desktop', source: 'vscode' } };
      if (method === 'thread/loaded/list') return { data: [] };
      if (method === 'thread/turns/list') return {
        data: [{ id: 'active', status: 'completed', completedAt: 200, itemsView: 'notLoaded', items: [] }],
        nextCursor: null,
      };
      assert.equal(method, 'thread/items/list', 'No mutation, alternate writer or unbounded history read');
      const index = Number(params.cursor || 0);
      assert.equal(params.limit, 1);
      assert.equal(params.sortDirection, 'asc');
      return {
        data: [{ turnId: params.turnId, item: { id: `item-${index}`, type: 'agentMessage', text: 'reply' } }],
        nextCursor: index === 0 ? '1' : null,
      };
    },
    onNotification: () => () => {}, onServerRequest: () => () => {},
    onDisconnect: () => () => {}, close: () => {},
  };
  const run = new CodexNativeQueueRun(client, 'desktop', {
    item: item => emitted.push(item.id), started: () => {},
  });
  return { run, client, calls, emitted };
}

test('desktop observation hydrates only its verified turn through ordered single-item pages', async () => {
  const f = fixture((method, params) => {
    if (method !== 'thread/turns/list') return;
    assert.equal(params.limit, 1);
    assert.equal(params.itemsView, 'notLoaded');
    return {
      data: [{ id: params.cursor ? 'active' : 'newer-foreign', status: 'completed',
        completedAt: 200, itemsView: 'notLoaded', items: [] }],
      nextCursor: params.cursor ? null : 'older-page',
    };
  });
  const result = await f.run.observe('active');
  assert.equal(result.turn?.id, 'active');
  assert.deepEqual(f.emitted, ['item-0', 'item-1']);
  assert.ok(f.calls.filter(call => call.method === 'thread/items/list')
    .every(call => call.params.turnId === 'active'));
});

for (const fault of [
  'foreign-turn', 'duplicate-item', 'repeated-cursor', 'missing-cursor',
  'empty-advancing-page', 'oversized-page', 'missing-type', 'summary-turn',
  'unloaded-with-items', 'unsupported-after-progress', 'rpc-failure',
]) {
  test(`desktop observation rejects ${fault} without emitting partial history or retrying input`, async () => {
    const f = fixture((method, params) => {
      if (method === 'thread/turns/list' && ['summary-turn', 'unloaded-with-items'].includes(fault)) return {
        data: [{ id: 'active', itemsView: fault === 'summary-turn' ? 'summary' : 'notLoaded',
          items: fault === 'unloaded-with-items' ? [{}] : [] }], nextCursor: null,
      };
      if (method !== 'thread/items/list') return;
      if (fault === 'rpc-failure' || (fault === 'unsupported-after-progress' && params.cursor)) {
        throw new AppError('Private provider details', {
          code: 'CODEX_STDIO_RPC_ERROR', details: { rpcCode: fault === 'rpc-failure' ? -32000 : -32601 },
        });
      }
      const item: AnyRecord = { id: `item-${params.cursor || 0}`, type: 'agentMessage' };
      const result: AnyRecord = { data: [{ turnId: 'active', item }], nextCursor: null };
      if (fault === 'foreign-turn') result.data[0].turnId = 'foreign';
      if (fault === 'duplicate-item') { item.id = 'duplicate'; result.nextCursor = params.cursor ? null : '1'; }
      if (fault === 'repeated-cursor') result.nextCursor = '1';
      if (fault === 'missing-cursor') delete result.nextCursor;
      if (fault === 'empty-advancing-page') { result.data = []; result.nextCursor = '1'; }
      if (fault === 'oversized-page') result.data.push({ turnId: 'active', item: { id: 'extra', type: 'agentMessage' } });
      if (fault === 'missing-type') delete item.type;
      if (fault === 'unsupported-after-progress') result.nextCursor = '1';
      return result;
    });
    await assert.rejects(f.run.observe('active'));
    assert.deepEqual(f.emitted, []);
    assert.ok(!f.calls.some(call => call.params.itemsView === 'full' || call.params.includeTurns === true));
  });
}

test('item pagination is checked before any desktop input is submitted', async () => {
  const f = fixture(method => {
    if (method === 'thread/items/list') return { data: [{ turnId: 'foreign', item: {} }], nextCursor: null };
  });
  await assert.rejects(f.run.run([{ type: 'text', text: 'Do not submit' }]));
  assert.ok(f.calls.some(call => call.method === 'thread/items/list'));
  assert.ok(!f.calls.some(call => ['thread/queue/add', 'turn/start'].includes(call.method)));
});

test('queued input is correlated across metadata and item pages by client identity exactly once', async () => {
  let submitted = false;
  let clientId = '';
  const f = fixture((method, params) => {
    if (method === 'thread/queue/list') return { data: [], nextCursor: null };
    if (method === 'thread/queue/add') {
      submitted = true;
      clientId = params.clientUserMessageId;
      return { queuedSubmission: { id: 'queued', clientUserMessageId: clientId } };
    }
    if (method === 'thread/turns/list') {
      const turns = submitted ? ['foreign', 'ours', 'baseline'] : ['baseline'];
      const index = Number(params.cursor || 0);
      return { data: [{ id: turns[index], status: 'completed', completedAt: 200,
        itemsView: 'notLoaded', items: [] }],
      nextCursor: index + 1 < turns.length ? String(index + 1) : null };
    }
    if (method === 'thread/items/list') {
      if (params.turnId === 'baseline') return { data: [], nextCursor: null };
      const own = params.turnId === 'ours';
      const item = params.cursor
        ? { id: 'answer', type: 'agentMessage', text: 'Matched native reply' }
        : { id: `${params.turnId}-user`, type: 'userMessage', clientId: own ? clientId : 'foreign-client' };
      return { data: [{ turnId: params.turnId, item }], nextCursor: own && !params.cursor ? 'answer-page' : null };
    }
  });
  const result = await f.run.run([{ type: 'text', text: 'Submit once' }]);
  assert.equal(result.turn?.id, 'ours');
  assert.deepEqual(f.emitted, ['answer']);
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  assert.ok(!f.calls.some(call => ['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(call.method)));
});

test('explicit initial unsupported item pagination permits one legacy turn, not an aggregate history read', async () => {
  const f = fixture((method, params) => {
    if (method === 'thread/items/list') throw new AppError('Unsupported', {
      code: 'CODEX_STDIO_RPC_ERROR', details: { rpcCode: -32601 },
    });
    if (method === 'thread/turns/list' && params.itemsView === 'full') return {
      data: [{ id: 'active', status: 'completed', completedAt: 200, itemsView: 'full',
        items: [{ id: 'legacy-reply', type: 'agentMessage' }] }], nextCursor: null,
    };
  });
  await f.run.observe('active');
  assert.deepEqual(f.emitted, ['legacy-reply']);
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 1);
  assert.ok(f.calls.filter(call => call.method === 'thread/turns/list')
    .every(call => call.params.limit === 1));
});

test('legacy fallback cannot silently adopt a new latest turn during a rollover', async () => {
  const f = fixture((method, params) => {
    if (method === 'thread/items/list') throw new AppError('Unsupported', {
      code: 'CODEX_STDIO_RPC_ERROR', details: { rpcCode: -32601 },
    });
    if (method === 'thread/turns/list' && params.itemsView === 'full') return {
      data: [{ id: 'replacement', status: 'completed', completedAt: 200, items: [] }], nextCursor: null,
    };
  });
  await assert.rejects(f.run.observe('active'), { code: 'CODEX_NATIVE_TURN_PROTOCOL_ERROR' });
  assert.deepEqual(f.emitted, []);
});

test('item capability cannot fall back after a previous successful turn read', async () => {
  let unsupported = false;
  const f = fixture(method => {
    if (method === 'thread/items/list' && unsupported) throw new AppError('Unsupported', {
      code: 'CODEX_STDIO_RPC_ERROR', details: { rpcCode: -32601 },
    });
    return undefined;
  });
  const reader = new CodexNativeTurnReader(f.client, 'desktop');
  const turn = (await reader.page()).data[0];
  await reader.hydrate(turn, null);
  unsupported = true;
  await assert.rejects(reader.hydrate(turn, null), { code: 'CODEX_STDIO_RPC_ERROR' });
  assert.ok(!f.calls.some(call => call.params.itemsView === 'full'));
});

test('live turn traversal rejects repeated turns and non-progressing metadata pages', async () => {
  for (const empty of [false, true]) {
    const f = fixture((method, params) => {
      if (method !== 'thread/turns/list') return;
      return { data: empty ? [] : [{ id: 'foreign', items: [], itemsView: 'notLoaded' }],
        nextCursor: params.cursor ? 'next-again' : 'next' };
    });
    await assert.rejects(f.run.observe('active'));
    assert.deepEqual(f.emitted, []);
    assert.ok(!f.calls.some(call => call.method === 'thread/items/list'));
  }
});

test('live turn aggregate memory budget rejects oversized histories without partial emission', async () => {
  const payload = 'x'.repeat(15 * 1024 * 1024);
  const f = fixture((method, params) => {
    if (method !== 'thread/items/list') return;
    const index = Number(params.cursor || 0);
    return {
      data: [{ turnId: 'active', item: { id: `large-${index}`, type: 'agentMessage', text: payload } }],
      nextCursor: String(index + 1),
    };
  });
  await assert.rejects(f.run.observe('active'), { code: 'CODEX_NATIVE_TURN_PROTOCOL_ERROR' });
  assert.ok(f.calls.filter(call => call.method === 'thread/items/list').length < 10);
  assert.deepEqual(f.emitted, []);
});

test('real stdio desktop observation reads a turn over 16 MiB without increasing transport limits', async () => {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'codey-live-history-'));
  let client: ICodexRpcClient | undefined;
  try {
    const script = path.join(root, 'fixture.cjs');
    await writeFile(script, `
const payload = 'x'.repeat(1024 * 1024);
const item = i => ({id:'item-'+i,type:'mcpToolCall',result:{content:[{type:'image',data:payload}]}});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line); if(r.id===undefined) return;
  const p=r.params; let result;
  if(r.method==='initialize') result={};
  else if(r.method==='thread/loaded/list') result={data:[]};
  else if(r.method==='thread/turns/list') result={data:[{id:'active',status:'completed',completedAt:200,
    itemsView:p.itemsView,items:p.itemsView==='notLoaded'?[]:Array.from({length:20},(_,i)=>item(i))}],nextCursor:null};
  else if(r.method==='thread/items/list' && p.turnId==='active' && p.limit===1) {
    const i=Number(p.cursor||0);
    result={data:[{turnId:'active',item:item(i)}],nextCursor:i<19?String(i+1):null};
  } else throw new Error('Unexpected or mutating RPC: '+r.method);
  process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});`);
    client = await CodexStdioClient.connect({
      executable: process.execPath, launcherArgs: [script], home: root, timeoutMs: 10_000,
    });
    const emitted: string[] = [];
    const positions: number[] = [];
    const run = new CodexNativeQueueRun(client, 'desktop', {
      started: id => assert.equal(id, 'active'),
      item: (item, turnId, position) => {
        assert.equal(turnId, 'active');
        emitted.push(item.id);
        positions.push(position.itemIndex);
      },
    });
    const result = await run.observe('active');
    assert.ok(Buffer.byteLength(JSON.stringify(result.turn)) > 16 * 1024 * 1024);
    assert.deepEqual(emitted, Array.from({ length: 20 }, (_, i) => `item-${i}`));
    assert.deepEqual(positions, Array.from({ length: 20 }, (_, i) => i));
  } finally {
    await client?.close();
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('codey-live-history-'));
    await rm(root, { recursive: true, force: true });
  }
});
