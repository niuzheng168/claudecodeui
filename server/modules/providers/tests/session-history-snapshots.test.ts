import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionHistorySnapshots } from '@/modules/providers/services/session-history-snapshots.service.js';
import type { FetchHistoryResult, NormalizedMessage } from '@/shared/index.js';

function history(count: number): FetchHistoryResult {
  return {
    messages: Array.from({ length: count }, (_, index) => ({
      id: `row-${index}`, sessionId: 'session', provider: 'codex', kind: 'text', role: 'assistant',
      content: `row ${index}`, timestamp: '2026-09-19T00:00:00.000Z',
    } as NormalizedMessage)),
    total: count, hasMore: false, offset: 0, limit: null,
  };
}

test('80 consecutive older pages reach the first message with exactly one native history traversal', async () => {
  const cache = createSessionHistorySnapshots();
  let loads = 0;
  const load = async () => { loads++; return history(1601); };
  let page = await cache.page({ source: 'node/account/session', limit: 20, load });
  const seen = new Set(page.messages.map(message => message.id));
  while (page.hasMore) {
    const before = page.messages[0].id;
    page = await cache.page({ source: 'node/account/session', limit: 20, snapshotId: page.snapshotId, before, load });
    assert.equal(page.before, before);
    assert.ok(page.messages.length > 0);
    for (const message of page.messages) {
      assert.equal(seen.has(message.id), false);
      seen.add(message.id);
    }
  }
  assert.equal(loads, 1);
  assert.equal(seen.size, 1601);
  assert.equal(page.messages[0].id, 'row-0');
});

test('tail updates cannot move a pinned older boundary and expired handles recover using the row ID', async () => {
  let time = 0;
  const cache = createSessionHistorySnapshots({ now: () => time, maxAgeMs: 10 });
  let count = 100, loads = 0;
  const load = async () => { loads++; return history(count); };
  const first = await cache.page({ source: 'session', limit: 20, load });
  count = 150;
  const latest = await cache.page({ source: 'session', limit: 20, load });
  assert.equal(latest.total, 150);
  const old = await cache.page({ source: 'session', limit: 20, snapshotId: first.snapshotId, before: 'row-80', load });
  assert.equal(old.messages[0].id, 'row-60');
  assert.equal(old.total, 100);
  assert.equal(loads, 2);
  time = 11;
  const recovered = await cache.page({ source: 'session', limit: 20, snapshotId: old.snapshotId, before: 'row-60', load });
  assert.equal(recovered.messages[0].id, 'row-40');
  assert.equal(recovered.offset, 90);
  assert.equal(recovered.total, 150);
  assert.equal(loads, 3);
  await assert.rejects(cache.page({ source: 'session', limit: 20, snapshotId: first.snapshotId, load }), {
    code: 'HISTORY_SNAPSHOT_EXPIRED',
  });
});

test('session/account source mismatches and deleted anchors fail closed', async () => {
  const cache = createSessionHistorySnapshots({ maxEntries: 1 });
  const load = async () => history(40);
  const first = await cache.page({ source: 'session-a', limit: 20, load });
  await assert.rejects(cache.page({ source: 'session-b', snapshotId: first.snapshotId, before: 'row-20', load }), {
    code: 'HISTORY_SNAPSHOT_MISMATCH',
  });
  await cache.page({ source: 'session-b', load });
  await assert.rejects(cache.page({
    source: 'session-a', snapshotId: first.snapshotId, before: 'row-20', load: async () => history(10),
  }), { code: 'HISTORY_ANCHOR_NOT_FOUND' });
});

test('concurrent initial reads share one load and failed loads can be retried', async () => {
  const cache = createSessionHistorySnapshots();
  let loads = 0;
  const load = async () => { loads++; await new Promise(resolve => setTimeout(resolve, 5)); return history(40); };
  const [a, b] = await Promise.all([cache.page({ source: 's', load }), cache.page({ source: 's', load })]);
  assert.equal(a.snapshotId, b.snapshotId);
  assert.equal(loads, 1);
  await assert.rejects(cache.page({ source: 'error', load: async () => { throw new Error('read failed'); } }));
  assert.equal((await cache.page({ source: 'error', load })).total, 40);
});

test('oversized snapshots serve the cold read but are not retained, and anchor reconstruction still advances', async () => {
  const cache = createSessionHistorySnapshots({ maxBytes: 1 });
  let loads = 0;
  const load = async () => { loads++; return history(40); };
  const first = await cache.page({ source: 's', limit: 20, load });
  await assert.rejects(cache.page({ source: 's', snapshotId: first.snapshotId, load }), {
    code: 'HISTORY_SNAPSHOT_EXPIRED',
  });
  const earlier = await cache.page({ source: 's', snapshotId: first.snapshotId, before: 'row-20', limit: 20, load });
  assert.equal(earlier.messages[0].id, 'row-0');
  assert.equal(earlier.hasMore, false);
  assert.equal(loads, 2);
});

test('reading an older page touches its snapshot before the next LRU eviction', async () => {
  const cache = createSessionHistorySnapshots({ maxEntries: 2 });
  const load = async () => history(80);
  const a = await cache.page({ source: 'a', limit: 20, load });
  const b = await cache.page({ source: 'b', limit: 20, load });
  await cache.page({ source: 'a', snapshotId: a.snapshotId, before: 'row-60', limit: 20, load });
  await cache.page({ source: 'c', limit: 20, load });
  await assert.rejects(cache.page({ source: 'b', snapshotId: b.snapshotId, load }), {
    code: 'HISTORY_SNAPSHOT_EXPIRED',
  });
  assert.equal((await cache.page({ source: 'a', snapshotId: a.snapshotId, load })).messages.length, 80);
});

test('forward pages replay their anchor, preserve equal timestamps, and revalidate a pinned tail', async () => {
  const cache = createSessionHistorySnapshots();
  let count = 50;
  const load = async () => history(count);
  let page = await cache.page({ source: 's', limit: 20, load });
  count = 125;
  const seen = new Set<string>();
  let after = 'row-49';
  do {
    page = await cache.page({ source: 's', limit: 20, snapshotId: page.snapshotId, after, load });
    assert.equal(page.after, after);
    assert.equal(page.messages[0].id, after);
    assert.ok(page.messages.length <= 20);
    for (const row of page.messages.slice(1)) {
      assert.ok(!seen.has(row.id));
      seen.add(row.id);
    }
    after = page.messages.at(-1)!.id;
  } while (page.hasNewer);
  assert.equal(seen.size, 75);
  assert.equal(after, 'row-124');
  count = 20;
  await assert.rejects(cache.page({ source: 's', limit: 20, snapshotId: page.snapshotId, after, load }), {
    code: 'HISTORY_ANCHOR_NOT_FOUND',
  });
});

test('native forward pages extend a snapshot without full-history reads or losing older boundaries', async () => {
  const cache = createSessionHistorySnapshots();
  let loads = 0;
  const load = async () => { loads++; return history(100); };
  const first = await cache.page({ source: 's', limit: 20, load });
  const newer = await cache.page({
    source: 's', limit: 20, snapshotId: first.snapshotId, after: 'row-99', load,
    loadAfter: async (previous, anchor, limit) => {
      assert.equal(previous.total, 100);
      assert.equal(anchor, 'row-99');
      assert.equal(limit, 20);
      return { ...history(119), messages: history(119).messages.slice(99), hasNewer: true };
    },
  });
  assert.equal(loads, 1);
  assert.equal(newer.messages.length, 20);
  assert.equal(newer.hasNewer, true);
  const old = await cache.page({ source: 's', limit: 20, snapshotId: newer.snapshotId, before: 'row-80', load });
  assert.equal(old.messages[0].id, 'row-60');
  assert.equal(old.total, 119);
  assert.equal(loads, 1);
  const all = await cache.page({ source: 's', snapshotId: newer.snapshotId, limit: null, load: async () => history(200) });
  assert.equal(all.messages.length, 200, 'explicit Load all does not mistake a partial catch-up for complete history');
});
