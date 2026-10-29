import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionSummaryScheduler } from '@/modules/activity/services/session-summary-scheduler.service.js';
import type { SessionSummary, SessionSummaryRequest } from '@/shared/index.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A scheduler over a fake clock whose generator answers at once, or holds every answer when `hold` is set. */
function fixture(options: { hold?: boolean; timeoutMs?: number } = {}) {
  const state = {
    now: 1_000_000,
    settings: { settleMs: MINUTE, summaryTurns: 3, summaryMs: 10 * MINUTE, summaryMinIntervalMs: MINUTE, summaryConcurrency: 2 },
    requests: [] as SessionSummaryRequest[],
    held: [] as Array<(text: string | null) => void>,
    delivered: [] as Array<{ sessionId: string; summary: SessionSummary }>,
    warnings: 0,
  };
  const scheduler = new SessionSummaryScheduler({
    summarize: async (request) => {
      state.requests.push(request);
      if (options.hold) return new Promise<string | null>((resolve) => state.held.push(resolve));
      return `${request.reason} ${request.sessionId}`;
    },
    deliver: (sessionId, summary) => state.delivered.push({ sessionId, summary }),
    settings: () => state.settings,
    now: () => state.now,
    warn: () => { state.warnings += 1; },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const advance = (ms: number) => { state.now += ms; };
  const start = (sessionId: string) => scheduler.observe({ sessionId, provider: 'claude', busy: true, turnStartedAt: state.now });
  const end = (sessionId: string, failed = false) => scheduler.observe({ sessionId, provider: 'claude', busy: false, turnEnded: { failed } });
  const wait = (sessionId: string, kind?: 'permission' | 'question') => scheduler.observe({
    sessionId, provider: 'claude', busy: true, waiting: kind ? { kind } : {},
  });
  /** Polls, then lets the generations it started finish. */
  const poll = async (enabled = true) => {
    scheduler.poll(enabled);
    await settle();
  };
  /** One turn: starts, runs for `ms`, ends. */
  const turn = (sessionId: string, ms: number) => {
    start(sessionId);
    advance(ms);
    end(sessionId);
  };
  const reasons = () => state.requests.map((request) => request.reason);
  return { state, scheduler, advance, start, end, wait, poll, turn, reasons };
}

test('waiting and failures are summarized at once, whatever the interval since the last summary', async () => {
  const f = fixture();
  const startedAt = f.state.now;
  f.start('a');
  f.advance(10 * SECOND);
  f.wait('a', 'permission');
  await f.poll();
  assert.deepEqual(f.state.requests, [{
    sessionId: 'a', provider: 'claude', reason: 'waiting', at: startedAt + 10 * SECOND,
    waitingKind: 'permission', segmentStartedAt: startedAt,
  }]);
  assert.deepEqual(f.state.delivered, [{
    sessionId: 'a', summary: { text: 'waiting a', reason: 'waiting', at: startedAt + 10 * SECOND },
  }]);

  f.advance(5 * SECOND);
  f.end('a', true);
  await f.poll();
  assert.deepEqual(f.reasons(), ['waiting', 'failed'], 'five seconds after the waiting summary');
  assert.equal(f.state.requests[1].turnEndedAt, f.state.now);
  assert.equal(f.state.requests[1].segmentStartedAt, startedAt);

  f.advance(5 * MINUTE);
  await f.poll();
  assert.deepEqual(f.reasons(), ['waiting', 'failed'], 'a failure leaves nothing to settle');
});

test('a turn is summarized once no other follows it for settleMs, and covers the turns before it', async () => {
  const f = fixture();
  const firstStart = f.state.now;
  f.turn('a', 20 * SECOND);
  f.advance(30 * SECOND);
  f.turn('a', 20 * SECOND);
  const endedAt = f.state.now;
  f.advance(MINUTE - SECOND);
  await f.poll();
  assert.deepEqual(f.state.requests, [], 'not before settleMs');
  f.advance(SECOND);
  await f.poll();
  assert.deepEqual(f.state.requests, [{
    sessionId: 'a', provider: 'claude', reason: 'settled', at: f.state.now,
    segmentStartedAt: firstStart, turnEndedAt: endedAt,
  }]);
  f.advance(10 * MINUTE);
  await f.poll();
  assert.equal(f.state.requests.length, 1, 'once');

  f.turn('b', 5 * SECOND);
  f.advance(50 * SECOND);
  f.start('b');
  f.advance(MINUTE);
  await f.poll();
  assert.equal(f.state.requests.length, 1, 'a new turn within settleMs means it has not settled');
});

test('a session that keeps running is summarized every summaryTurns turns, at the end of a turn', async () => {
  const f = fixture();
  const firstStart = f.state.now;
  f.turn('a', 30 * SECOND);
  f.advance(10 * SECOND);
  f.turn('a', 30 * SECOND);
  f.advance(10 * SECOND);
  await f.poll();
  assert.deepEqual(f.state.requests, []);
  f.turn('a', 30 * SECOND);
  const thirdEnd = f.state.now;
  await f.poll();
  assert.deepEqual(f.state.requests, [{
    sessionId: 'a', provider: 'claude', reason: 'continuous', at: thirdEnd,
    segmentStartedAt: firstStart, turnEndedAt: thirdEnd,
  }]);

  f.advance(2 * MINUTE);
  await f.poll();
  assert.equal(f.state.requests.length, 1, 'nothing new to settle');

  // The next run of turns counts from its own first turn.
  f.turn('a', 30 * SECOND);
  f.advance(10 * SECOND);
  f.turn('a', 30 * SECOND);
  f.advance(10 * SECOND);
  f.turn('a', 30 * SECOND);
  await f.poll();
  assert.deepEqual(f.reasons(), ['continuous', 'continuous']);
});

test('or every summaryMs, whichever comes first; a single long turn settles instead', async () => {
  const f = fixture();
  const firstStart = f.state.now;
  f.turn('a', 5 * MINUTE);
  f.advance(10 * SECOND);
  f.turn('a', 5 * MINUTE);
  await f.poll();
  assert.deepEqual(f.state.requests.map((request) => [request.reason, request.segmentStartedAt]), [['continuous', firstStart]],
    'two turns, ten minutes');

  f.advance(MINUTE);
  f.turn('b', 15 * MINUTE);
  await f.poll();
  assert.equal(f.state.requests.length, 1, 'one long turn is not a session that keeps running');
  f.advance(MINUTE);
  await f.poll();
  assert.deepEqual(f.reasons(), ['continuous', 'settled']);
});

test('summaries other than waiting and failures are at least summaryMinIntervalMs apart', async () => {
  const f = fixture();
  f.state.settings.summaryMinIntervalMs = 2 * MINUTE;
  f.start('a');
  f.wait('a', 'question');
  await f.poll();
  const waitingAt = f.state.now;
  f.advance(10 * SECOND);
  f.end('a');
  f.advance(MINUTE);
  await f.poll();
  assert.deepEqual(f.reasons(), ['waiting'], 'settled seventy seconds after the last summary is too soon');
  f.state.now = waitingAt + 2 * MINUTE - SECOND;
  await f.poll();
  assert.deepEqual(f.reasons(), ['waiting']);
  f.advance(SECOND);
  await f.poll();
  assert.deepEqual(f.reasons(), ['waiting', 'settled'], 'deferred, not dropped');

  // A session that keeps running skips a turn end that comes too soon, and takes a later one.
  const g = fixture();
  g.state.settings.summaryMinIntervalMs = 2 * MINUTE;
  g.state.settings.summaryTurns = 2;
  g.turn('b', 20 * SECOND);
  g.advance(5 * SECOND);
  g.turn('b', 20 * SECOND);
  await g.poll();
  g.advance(5 * SECOND);
  g.turn('b', 20 * SECOND);
  g.advance(5 * SECOND);
  g.turn('b', 20 * SECOND);
  await g.poll();
  assert.deepEqual(g.reasons(), ['continuous'], 'two more turns, but fifty seconds after the first summary');
  g.advance(5 * SECOND);
  g.turn('b', 70 * SECOND);
  await g.poll();
  assert.deepEqual(g.reasons(), ['continuous', 'continuous'], 'the next turn ends 125 seconds after it');
});

test('nothing is written while the Portal does not take summaries, and what came due meanwhile is dropped', async () => {
  const f = fixture();
  f.start('a');
  f.wait('a', 'permission');
  f.turn('b', 30 * SECOND);
  f.advance(MINUTE);
  await f.poll(false);
  await f.poll(true);
  assert.deepEqual(f.state.requests, []);

  f.turn('c', 30 * SECOND);
  await f.poll(false);
  f.advance(MINUTE);
  await f.poll(true);
  assert.deepEqual(f.reasons(), ['settled'], 'a settle still ahead when summaries came back is kept');
});

test('a few at a time, up to 32 waiting; waiting and failures go first and push out ordinary ones', async () => {
  const f = fixture({ hold: true });
  for (let index = 0; index < 36; index += 1) f.turn(`s${index}`, 30 * SECOND);
  f.advance(MINUTE);
  await f.poll();
  assert.equal(f.state.requests.length, 2, 'summaryConcurrency');

  for (let index = 0; index < 4; index += 1) f.turn(`t${index}`, 30 * SECOND);
  f.advance(MINUTE);
  await f.poll();
  f.start('urgent-1');
  f.wait('urgent-1');
  f.start('urgent-2');
  f.end('urgent-2', true);
  await f.poll();
  assert.equal(f.state.requests.length, 2);

  for (let index = 0; index < 40 && f.state.held.length; index += 1) {
    f.state.held.shift()!('done');
    await settle();
  }
  assert.equal(f.state.held.length, 0);
  const started = f.state.requests.map((request) => request.sessionId);
  assert.equal(started.length, 2 + 32, 'two at work and thirty-two waiting; the rest were dropped');
  assert.deepEqual(started.slice(0, 4), ['s0', 's1', 'urgent-1', 'urgent-2'], 'waiting and failures next');
  assert.deepEqual(started.slice(4, 6), ['s4', 's5'], 'the two oldest waiting ordinary ones made room for them');
  assert.deepEqual(started.slice(-2), ['t0', 't1']);
  for (const dropped of ['s32', 's35', 't2', 't3']) assert.ok(!started.includes(dropped), `${dropped} found the queue full`);
  assert.equal(f.state.delivered.length, 34);
});

test('a newer summary of a session replaces one still waiting for a slot', async () => {
  const f = fixture({ hold: true });
  f.state.settings.summaryConcurrency = 1;
  f.start('busy');
  f.wait('busy');
  await f.poll();
  f.start('a');
  f.wait('a', 'permission');
  await f.poll();
  f.advance(SECOND);
  f.end('a', true);
  await f.poll();
  f.state.held.shift()!('done');
  await settle();
  assert.deepEqual(f.state.requests.map((request) => [request.sessionId, request.reason]), [['busy', 'waiting'], ['a', 'failed']]);
});

test('a summary past its deadline is dropped and frees its slot', async () => {
  const f = fixture({ hold: true, timeoutMs: 200 });
  f.state.settings.summaryConcurrency = 1;
  f.start('a');
  f.wait('a');
  f.start('b');
  f.wait('b');
  await f.poll();
  assert.equal(f.state.requests.length, 1);
  // a's deadline passes at 200 ms and b starts; b's own passes at about 400 ms.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.state.requests.length, 2, 'the next one started after the deadline');
  f.state.held[1]('in time');
  f.state.held[0]('too late');
  await settle();
  assert.deepEqual(f.state.delivered.map((entry) => entry.summary.text), ['in time']);
});
