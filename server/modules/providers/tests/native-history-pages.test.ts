import assert from 'node:assert/strict';
import test from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { createNativeHistoryPages } from '@/modules/providers/services/native-history-pages.service.js';
import type { AnyRecord, CodexHistoryPageRequest, FetchHistoryResult, ICodexRpcClient } from '@/shared/index.js';

function fixture(count: number) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const client = {
    ownsProcess: true,
    async request(method: string, params: AnyRecord) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: 'fork', createdAt: 1700000000 } };
      if (method === 'thread/loaded/list') return { data: [] };
      if (method === 'thread/turns/list') {
        assert.equal(params.itemsView, 'notLoaded');
        return { data: [{ id: 'inherited-turn', startedAt: 1700000000 }], nextCursor: null };
      }
      assert.equal(method, 'thread/items/list');
      assert.equal(params.turnId, undefined, 'the fork owns a chain of inherited history, not a copied JSONL');
      assert.equal(params.limit, 1, 'keep atomic item frames bounded');
      const index = params.cursor == null ? (params.sortDirection === 'desc' ? count - 1 : 0) : Number(params.cursor);
      const next = index + (params.sortDirection === 'desc' ? -1 : 1);
      return {
        data: index >= 0 && index < count ? [{ turnId: 'inherited-turn', item: { id: `item-${index}`, type: 'agentMessage', text: `row ${index}` } }] : [],
        nextCursor: next >= 0 && next < count ? String(next) : null,
        backwardsCursor: String(index),
      };
    },
  } as unknown as ICodexRpcClient;
  const load = async (page: CodexHistoryPageRequest): Promise<FetchHistoryResult> => {
    const result = await codexAppServer.readThreadPage('fork', client, page, () => true);
    return {
      messages: result.records.map((entry: AnyRecord) => ({
        id: entry.item.id, sessionId: 'app', kind: 'text', role: 'assistant', provider: 'codex',
        timestamp: entry.turnStartedAt, content: entry.item.text,
        historyBeforeCursor: entry.descCursor,
        nativePosition: { turnId: entry.turnId, turnStartedAt: entry.turnStartedAt, itemIndex: entry.index,
          itemId: entry.item.id, cursor: entry.ascCursor, orderScope: entry.orderScope },
      })),
      total: result.records.length, offset: 0, limit: page.limit,
      hasMore: page.direction === 'desc' && result.more, hasNewer: page.direction === 'asc' && result.more,
    };
  };
  return { client, load, calls, append: (added: number) => { count += added; } };
}

test('a cold 100000-item fork reads just its newest 20 items, then pages backwards with no full snapshot', async () => {
  const f = fixture(100000), service = createNativeHistoryPages();
  let page = await service.page({ source: 'owner/fork', options: { limit: 20 }, load: f.load });
  assert.equal(page.messages.length, 20);
  assert.equal(page.messages[0].id, 'item-99980');
  assert.equal(page.messages.at(-1)?.id, 'item-99999');
  assert.equal(page.totalIsExact, false);
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 20);
  assert.ok(!f.calls.some(call => call.params.includeTurns === true));
  assert.ok(page.beforeCursor && page.syncCursor);
  const first = page.messages[0];
  const newerCursor = page.syncCursor!;
  page = await service.page({ source: 'owner/fork', options: {
    limit: 20, before: first.id, beforeCursor: page.beforeCursor,
  }, load: f.load });
  assert.equal(page.messages[0].id, 'item-99960');
  assert.equal(page.messages.at(-1)?.id, 'item-99979');
  assert.equal(page.messages.at(-1)?.nativePosition?.itemIndex, -20);
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 41);
  const refreshed = await service.page({ source: 'owner/fork', options: {
    limit: 20, after: 'item-99999', syncCursor: newerCursor,
  }, load: f.load });
  assert.equal(refreshed.messages.length, 1);
  assert.equal(refreshed.hasNewer, false);
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 42);
});

test('every older native page reaches the inherited first item without gaps or duplicates', async () => {
  const f = fixture(101), service = createNativeHistoryPages();
  let page = await service.page({ source: 's', options: { limit: 20 }, load: f.load });
  const seen = new Set(page.messages.map(message => message.id));
  while (page.hasMore) {
    page = await service.page({ source: 's', options: {
      limit: 20, before: page.messages[0].id, beforeCursor: page.beforeCursor,
    }, load: f.load });
    for (const message of page.messages) {
      assert.ok(!seen.has(message.id));
      seen.add(message.id);
    }
  }
  assert.equal(seen.size, 101);
  assert.ok(seen.has('item-0'));
});

test('trimmed cache rows retain their own seek points, and foreign/tampered cursors cannot read history', async () => {
  const f = fixture(100), service = createNativeHistoryPages();
  const page = await service.page({ source: 's', options: { limit: 20 }, load: f.load });
  const retained = page.messages[10];
  const older = await service.page({ source: 's', options: {
    limit: 20, before: retained.id, beforeCursor: String(retained.historyPageBefore),
  }, load: f.load });
  assert.equal(older.messages.at(-1)?.id, 'item-89');
  const reads = f.calls.length;
  await assert.rejects(service.page({ source: 'other-owner', options: {
    limit: 20, before: retained.id, beforeCursor: String(retained.historyPageBefore),
  }, load: f.load }), { code: 'HISTORY_SNAPSHOT_MISMATCH' });
  await assert.rejects(service.page({ source: 's', options: {
    limit: 20, before: retained.id, beforeCursor: 'np.tampered.invalid',
  }, load: f.load }), { code: 'HISTORY_SNAPSHOT_EXPIRED' });
  assert.equal(f.calls.length, reads);
});

test('a cold checkpoint catches up forwards page by page without rereading the inherited prefix', async () => {
  const f = fixture(100000), service = createNativeHistoryPages();
  let page = await service.page({ source: 's', options: { limit: 20 }, load: f.load });
  f.append(45);
  const added: string[] = [];
  do {
    page = await service.page({ source: 's', options: {
      limit: 20, after: page.messages.at(-1)!.id, syncCursor: page.syncCursor,
    }, load: f.load });
    added.push(...page.messages.slice(1).map(message => message.id));
  } while (page.hasNewer);
  assert.deepEqual(added, Array.from({ length: 45 }, (_, i) => `item-${100000 + i}`));
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 68);
});

test('multi-row native items stay atomic and a mid-item cache boundary does not skip earlier projections', async () => {
  const f = fixture(8), service = createNativeHistoryPages();
  const load = async (request: CodexHistoryPageRequest) => {
    const page = await f.load(request);
    return { ...page, messages: page.messages.flatMap(message =>
      ['a', 'b', 'c'].map(suffix => ({ ...message, id: `${message.id}-${suffix}` }))) };
  };
  const page = await service.page({ source: 's', options: { limit: 2 }, load });
  assert.equal(page.messages.length, 6);
  const retained = page.messages[1];
  const older = await service.page({ source: 's', options: {
    limit: 2, before: retained.id, beforeCursor: String(retained.historyPageBefore),
  }, load });
  assert.equal(older.messages.at(-1)?.id, 'item-6-a');
  assert.equal(older.messages.length, 7);
  const next = await service.page({ source: 's', options: {
    limit: 2, after: 'item-7-a', syncCursor: page.syncCursor,
  }, load });
  assert.deepEqual(next.messages.map(message => message.id), ['item-7-a', 'item-7-b', 'item-7-c']);
});

test('expired checkpoints fail before any native read and empty forks need no item hydration', async () => {
  let now = 0;
  const f = fixture(3), service = createNativeHistoryPages({ now: () => now });
  const page = await service.page({ source: 's', options: { limit: 2 }, load: f.load });
  const calls = f.calls.length;
  now = 8 * 24 * 60 * 60_000;
  await assert.rejects(service.page({ source: 's', options: {
    limit: 2, before: page.messages[0].id, beforeCursor: page.beforeCursor,
  }, load: f.load }), { code: 'HISTORY_SNAPSHOT_EXPIRED' });
  assert.equal(f.calls.length, calls);
  const empty = fixture(0);
  const result = await service.page({ source: 'empty', options: { limit: 20 }, load: empty.load });
  assert.equal(result.messages.length, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.beforeCursor, undefined);
});

for (const fault of ['no-progress', 'missing-reverse', 'missing-turn', 'duplicate-item', 'writer']) {
  test(`cold native paging rejects ${fault} without a full-history fallback`, async () => {
    const f = fixture(10);
    const request = f.client.request.bind(f.client);
    f.client.request = async (method, params) => {
      const result = await request(method, params);
      if (method === 'thread/items/list') {
        if (fault === 'no-progress') result.data = [];
        if (fault === 'missing-reverse') delete result.backwardsCursor;
        if (fault === 'duplicate-item') result.data[0].item.id = 'duplicate';
      }
      if (method === 'thread/turns/list' && fault === 'missing-turn') result.data = [];
      if (method === 'thread/loaded/list' && fault === 'writer') result.data = ['fork'];
      return result;
    };
    await assert.rejects(createNativeHistoryPages().page({
      source: 's', options: { limit: 2 }, load: f.load,
    }), { code: 'CODEX_HISTORY_UNAVAILABLE' });
    assert.ok(!f.calls.some(call => call.params.includeTurns || call.params.itemsView === 'full'));
  });
}
