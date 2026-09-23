import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const history: NormalizedMessage[] = Array.from({ length: 400 }, (_, itemIndex) => ({
  id: `item-${itemIndex}`,
  sessionId: 'session',
  provider: 'codex',
  kind: 'text',
  role: 'assistant',
  content: `Message ${itemIndex}`,
  timestamp: '2026-09-23T00:00:00.000Z',
  nativePosition: { turnId: 'active-turn', turnStartedAt: '2026-09-23T00:00:00.000Z', itemIndex },
}));

function serveHistory(total = 100) {
  const state = { total, growth: 0, nextGrowth: [] as number[], rewrite: false };
  sessionMessages.mockImplementation(async (_sessionId, { limit, offset }) => {
    state.total += state.nextGrowth.shift() ?? state.growth;
    const end = Math.max(0, state.total - offset);
    const start = Math.max(0, end - limit);
    const messages = history.slice(start, end).map(message => state.rewrite
      ? { ...message, id: `rewritten-${message.id}`, content: 'Rewritten history' }
      : message);
    return {
      ok: true,
      json: async () => ({ data: { messages, total: state.total, hasMore: start > 0 } }),
    };
  });
  return state;
}

async function openSession() {
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer('session', { limit: 20, offset: 0 });
  });
  return view;
}

function ids(start: number, end: number) {
  return history.slice(start, end).map(message => message.id);
}

beforeEach(() => {
  sessionMessages.mockReset();
});

test('older pages advance while every request sees new live rows, without chasing the latest tail', async () => {
  const state = serveHistory();
  const { result } = await openSession();
  state.growth = 5;

  for (let page = 0; page < 2; page++) {
    await act(async () => {
      const older = await result.current.fetchMore('session', { limit: 20 });
      assert.equal(older.prependedCount, 15);
    });
  }

  assert.deepEqual(result.current.getMessages('session').map(message => message.id), ids(50, 100));
  const slot = result.current.getSessionSlot('session')!;
  assert.equal(slot.total, 110);
  assert.equal(slot.offset, 60, 'the oldest boundary also counts ten not-yet-fetched new tail rows');
  assert.deepEqual(sessionMessages.mock.calls.map(([, options]) => options), [
    { limit: 20, offset: 0 }, { limit: 20, offset: 20 }, { limit: 20, offset: 40 },
  ]);
});

test('a page overtaken by a long live turn retries at the old boundary with an overlap anchor', async () => {
  const state = serveHistory();
  const { result } = await openSession();
  state.nextGrowth = [25, 5];

  await act(async () => {
    assert.equal((await result.current.fetchMore('session', { limit: 20 })).prependedCount, 15);
  });

  assert.deepEqual(result.current.getMessages('session').map(message => message.id), ids(65, 100));
  assert.equal(result.current.getSessionSlot('session')?.offset, 65);
  assert.deepEqual(sessionMessages.mock.calls.map(([, options]) => options), [
    { limit: 20, offset: 0 }, { limit: 20, offset: 20 }, { limit: 21, offset: 44 },
  ]);
});

test('a fully overlapping older page realigns the offset and advances in one bounded retry', async () => {
  const state = serveHistory();
  const { result } = await openSession();
  state.nextGrowth = [20, 0];

  await act(async () => {
    assert.equal((await result.current.fetchMore('session', { limit: 20 })).prependedCount, 20);
  });

  assert.deepEqual(result.current.getMessages('session').map(message => message.id), ids(60, 100));
  assert.equal(result.current.getSessionSlot('session')?.offset, 60);
  assert.deepEqual(sessionMessages.mock.calls.map(([, options]) => options), [
    { limit: 20, offset: 0 }, { limit: 20, offset: 20 }, { limit: 20, offset: 40 },
  ]);
});

test('a later tail refresh bridges omitted new rows without dropping already-loaded older messages', async () => {
  const state = serveHistory();
  const { result } = await openSession();
  state.nextGrowth = [25, 5];
  await act(async () => { await result.current.fetchMore('session', { limit: 20 }); });
  sessionMessages.mockClear();

  await act(async () => {
    assert.equal((await result.current.refreshLatestFromServer('session', { limit: 20 })).applied, true);
  });

  assert.deepEqual(result.current.getMessages('session').map(message => message.id), ids(65, 130));
  assert.equal(result.current.getSessionSlot('session')?.offset, 65);
  assert.deepEqual(sessionMessages.mock.calls.map(([, options]) => options), [
    { limit: 20, offset: 0 }, { limit: 11, offset: 20 },
  ]);
  await act(async () => { await result.current.fetchMore('session', { limit: 20 }); });
  assert.deepEqual(result.current.getMessages('session').map(message => message.id), ids(45, 130));
});

test('the oldest page remains reachable during streaming and stays complete after a tail refresh', async () => {
  const state = serveHistory(40);
  const { result } = await openSession();
  state.growth = 5;
  await act(async () => {
    await result.current.fetchMore('session', { limit: 20 });
    await result.current.fetchMore('session', { limit: 20 });
  });

  const slot = result.current.getSessionSlot('session')!;
  assert.deepEqual(slot.serverMessages.map(message => message.id), ids(0, 40));
  assert.equal(slot.hasMore, false);
  assert.equal(slot.offset, 50);
  state.growth = 0;
  await act(async () => { await result.current.refreshLatestFromServer('session', { limit: 20 }); });
  assert.deepEqual(slot.serverMessages.map(message => message.id), ids(0, 50));
  assert.equal(slot.hasMore, false);
});

test('a truncated transcript still reconciles authoritatively instead of prepending across a gap', async () => {
  const state = serveHistory();
  const { result } = await openSession();
  state.total = 15;
  await act(async () => {
    assert.equal((await result.current.fetchMore('session', { limit: 20 })).prependedCount, 0);
  });

  const slot = result.current.getSessionSlot('session')!;
  assert.deepEqual(slot.serverMessages.map(message => message.id), ids(0, 15));
  assert.equal(slot.hasMore, false);
  assert.equal(slot.offset, 15);
});

test('offset realignment requires an actual cached anchor, not just a plausible total or timestamp', async () => {
  const state = serveHistory();
  const { result } = await openSession();
  state.nextGrowth = [25, 0];
  state.rewrite = true;
  await act(async () => {
    assert.equal((await result.current.fetchMore('session', { limit: 20 })).prependedCount, 0);
  });

  const slot = result.current.getSessionSlot('session')!;
  assert.deepEqual(slot.serverMessages.map(message => message.id), ids(80, 100));
  assert.equal(slot.offset, 20);
  assert.equal(slot.total, 100);
  assert.equal(sessionMessages.mock.calls.length, 3, 'do not loop or fetch the whole transcript');
});

test('rapid growth exhausts only two older-page attempts and a later retry can recover', async () => {
  const state = serveHistory();
  const { result } = await openSession();
  state.growth = 25;
  await act(async () => {
    assert.equal((await result.current.fetchMore('session', { limit: 20 })).prependedCount, 0);
  });
  assert.equal(sessionMessages.mock.calls.length, 3);
  assert.deepEqual(result.current.getMessages('session').map(message => message.id), ids(80, 100));

  state.growth = 0;
  await act(async () => {
    assert.equal((await result.current.fetchMore('session', { limit: 20 })).prependedCount, 20);
  });
  assert.deepEqual(result.current.getMessages('session').map(message => message.id), ids(60, 100));
});
