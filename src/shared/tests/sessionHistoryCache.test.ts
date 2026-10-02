import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearSessionHistoryCache, createSessionHistoryCache } from '@/shared/utils';
import type { CachedSessionHistory } from '@/shared/types';

function record(sessionId = 'session'): CachedSessionHistory {
  return {
    sessionId, total: 100, offset: 1, hasMore: true, fetchedAt: Date.now(), snapshotId: 'snapshot',
    messages: [{
      id: 'row', kind: 'text', provider: 'codex', sessionId,
      role: 'assistant', content: 'Earlier history 中文', timestamp: '2026-09-19T00:00:00.000Z',
    }],
    view: { visibleCount: 100, scrollTop: 123, scrolledUp: true },
  };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__ = '/cloudcli/node-a/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__;
});

test('a new cache instance restores full history, stable paging and the saved viewport', async () => {
  const value = record();
  await createSessionHistoryCache('account-a').write(value);
  expect(await createSessionHistoryCache('account-a').read('session')).toEqual(value);
});

test('accounts and nodes on the same origin never read each other’s transcripts', async () => {
  await createSessionHistoryCache('account-a').write(record());
  expect(await createSessionHistoryCache('account-b').read('session')).toBeNull();
  (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__ = '/cloudcli/node-b/';
  expect(await createSessionHistoryCache('account-a').read('session')).toBeNull();
  expect(await createSessionHistoryCache(null).read('session')).toBeNull();
});

test('logout clears the deployment cache and fences old-account writes', async () => {
  const old = createSessionHistoryCache('account-a');
  const reset = vi.fn();
  const unsubscribe = old.onReset(reset);
  await old.write(record());
  clearSessionHistoryCache();
  await old.write(record('late-old-request'));
  expect(reset).toHaveBeenCalledTimes(1);
  expect(await createSessionHistoryCache('account-a').read('session')).toBeNull();
  expect(await createSessionHistoryCache('account-a').read('late-old-request')).toBeNull();
  unsubscribe();
});

test('denied IndexedDB and invalid/mixed-session records degrade to a cache miss', async () => {
  const cache = createSessionHistoryCache('account-a');
  await cache.write({ ...record(), offset: -1 });
  await cache.write({ ...record(), messages: [{ ...record().messages[0], sessionId: 'foreign-session' }] });
  expect(await cache.read('session')).toBeNull();
  vi.stubGlobal('indexedDB', { open: () => { throw new Error('storage denied'); } });
  await expect(cache.write(record())).resolves.toBeUndefined();
  expect(await cache.read('session')).toBeNull();
});

test('cache eviction keeps only the most recent forty sessions', async () => {
  const cache = createSessionHistoryCache('account-a');
  for (let i = 0; i < 41; i++) await cache.write(record(`session-${i}`));
  expect(await cache.read('session-0')).toBeNull();
  expect((await cache.read('session-40'))?.messages[0].content).toBe('Earlier history 中文');
});

test('an unavailable or indefinitely blocked IndexedDB open does not hang history loading', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('indexedDB', { open: () => ({}) });
    const reading = createSessionHistoryCache('account-a').read('session');
    await vi.advanceTimersByTimeAsync(1501);
    expect(await reading).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('expired records are ignored, and an oversized newest row cannot leave a stale checkpoint', async () => {
  const cache = createSessionHistoryCache('account-a');
  const value = record();
  await cache.write(value);
  await cache.write({ ...value, messages: [{ ...value.messages[0], content: 'x'.repeat(17 * 1024 * 1024) }] });
  expect(await cache.read('session')).toBeNull();
  await cache.write(value);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60_000);
  expect(await cache.read('session')).toBeNull();
});

test('a 25 MB conversation saves its newest bounded window instead of freezing the previous cache', async () => {
  const cache = createSessionHistoryCache('account-a');
  const old = record();
  await cache.write(old);
  const messages = Array.from({ length: 5065 }, (_, index) => ({
    ...old.messages[0], id: `row-${index}`, content: 'x'.repeat(5100),
  }));
  const value = {
    ...old, messages, total: messages.length, offset: messages.length, hasMore: false,
    view: { visibleCount: -1, scrollTop: 50000, scrolledUp: false },
  };
  await cache.write(value);
  const restored = await createSessionHistoryCache('account-a').read('session');
  expect(restored?.messages).toEqual(messages.slice(-200));
  expect(restored?.messages.at(-1)?.id).toBe('row-5064');
  expect(restored?.offset).toBe(200);
  expect(restored?.hasMore).toBe(true);
  expect(restored?.total).toBe(5065);
  expect(restored?.view?.scrolledUp).toBe(false);
  expect(JSON.stringify(restored).length).toBeLessThan(4 * 1024 * 1024);
  // The live session is not trimmed; only its disk reopen window is bounded.
  expect(value.messages).toHaveLength(5065);
});

test('cache trimming preserves the reading anchor, timestamp collisions and an unseen forward gap', async () => {
  const value = record();
  const messages = Array.from({ length: 900 }, (_, index) => ({
    ...value.messages[0], id: `row-${index}`, content: 'x'.repeat(9000),
  }));
  await createSessionHistoryCache('account-a').write({
    ...value, messages, total: 1000, offset: 920, hasMore: true,
    view: { visibleCount: 900, scrollTop: 8000, scrolledUp: true, anchorId: 'row-620', anchorOffset: -12 },
  });
  const restored = await createSessionHistoryCache('account-a').read('session');
  expect(restored?.messages[0].id).toBe('row-620');
  expect(restored?.messages.at(-1)?.id).toBe('row-899');
  expect(restored?.offset).toBe(300);
  expect(restored?.view).toMatchObject({ scrolledUp: true, anchorId: 'row-620', anchorOffset: -12 });
});

test('concurrent writes cannot put an older tail back over the latest one', async () => {
  const cache = createSessionHistoryCache('account-a'), value = record();
  await Promise.all(Array.from({ length: 20 }, (_, index) => cache.write({
    ...value, snapshotId: `snapshot-${index}`, messages: [{ ...value.messages[0], id: `row-${index}` }],
  })));
  expect((await createSessionHistoryCache('account-a').read('session'))?.messages[0].id).toBe('row-19');
});

test('closing an old tab cannot replace the newer confirmed checkpoint written by another tab', async () => {
  const oldTab = createSessionHistoryCache('account-a'), newTab = createSessionHistoryCache('account-a');
  const value = record();
  await newTab.write({ ...value, fetchedAt: value.fetchedAt + 100, messages: [{ ...value.messages[0], id: 'latest' }] });
  await oldTab.write({ ...value, view: { visibleCount: 20, scrollTop: 0, scrolledUp: false } });
  expect((await newTab.read('session'))?.messages[0].id).toBe('latest');
});
test('logout fences an in-flight write, and disposed account caches cannot write', async () => {
  const cache = createSessionHistoryCache('account-a');
  const writing = cache.write(record());
  clearSessionHistoryCache();
  await writing;
  expect(await createSessionHistoryCache('account-a').read('session')).toBeNull();
  const next = createSessionHistoryCache('account-b');
  next.dispose();
  await next.write(record());
  expect(await createSessionHistoryCache('account-b').read('session')).toBeNull();
});
