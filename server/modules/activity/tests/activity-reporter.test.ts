import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActivityReporter,
  type ActivityOutcome,
  type ActivityReport,
  type ObservedSession,
} from '@/modules/activity/services/activity-reporter.service.js';
import type { SessionSummaryRequest } from '@/shared/index.js';

/**
 * A reporter over a fake clock, a settable set of busy sessions and a Portal
 * that records or refuses reports. With `summaries`, it summarizes at once as
 * "<reason> <session>", and the Portal can refuse reports carrying summaries.
 */
function fixture(options: { summaries?: boolean } = {}) {
  const state = {
    now: 1_000_000,
    busy: [] as ObservedSession[],
    outcomes: new Map<string, ActivityOutcome>(),
    sent: [] as ActivityReport[],
    fail: null as null | { status?: number },
    refuseSummaries: null as null | number,
    summarized: [] as SessionSummaryRequest[],
    reply: {
      accepted: true,
      settings: { version: 1, values: {} as Record<string, number> },
      ...(options.summaries ? { features: { summary: true } } : {}),
    } as { accepted: boolean; settings: { version: number; values: Record<string, number> }; features?: { summary: boolean } },
  };
  const reporter = new ActivityReporter({
    observe: async () => state.busy,
    outcomeOf: (sessionId) => state.outcomes.get(sessionId) ?? null,
    send: async (report) => {
      if (state.fail) throw Object.assign(new Error('refused'), state.fail);
      if (state.refuseSummaries && report.sessions.some((session) => session.summary)) {
        throw Object.assign(new Error('unknown field'), { status: state.refuseSummaries });
      }
      state.sent.push(structuredClone(report));
      return state.reply;
    },
    ...(options.summaries ? {
      summarize: async (request: SessionSummaryRequest) => {
        state.summarized.push(request);
        return `${request.reason} ${request.sessionId}`;
      },
    } : {}),
    now: () => state.now,
    version: '0.4.0',
  });
  /** Scans, sends whatever is due by now, then lets due summaries be written. */
  const step = async (ms = 0) => {
    state.now += ms;
    await reporter.scan();
    if (reporter.dueAt() <= state.now) await reporter.flush();
    reporter.pollSummaries();
    await new Promise((resolve) => setImmediate(resolve));
  };
  /** Every summary sent so far, as session, reason and text. */
  const summariesSent = () => state.sent.flatMap((report) => report.sessions
    .filter((session) => session.summary)
    .map((session) => [session.sessionId, session.summary!.reason, session.summary!.text]));
  return { state, reporter, step, summariesSent };
}

const claude = (sessionId: string, state: ObservedSession['state'], extra: Partial<ObservedSession> = {}): ObservedSession =>
  ({ sessionId, provider: 'claude', state, ...extra });

test('the first report after a start lists every busy session as a full report', async () => {
  const f = fixture();
  f.state.busy = [claude('a', 'running', { startedAt: 990_000 }), claude('b', 'background')];
  await f.step();
  assert.equal(f.state.sent.length, 1);
  const [report] = f.state.sent;
  assert.equal(report.full, true);
  assert.equal(report.seq, 0);
  assert.equal(report.version, '0.4.0');
  assert.deepEqual(report.sessions.map((s) => [s.sessionId, s.state, s.since]), [['a', 'running', 990_000], ['b', 'background', 1_000_000]]);
});

test('ordinary changes wait for the batch; waiting for the user goes out within seconds', async () => {
  const f = fixture();
  await f.step();
  f.state.busy = [claude('a', 'running')];
  await f.step(1_000);
  assert.equal(f.state.sent.length, 1, 'a turn starting waits for the batch');
  await f.step(29_000);
  assert.equal(f.state.sent.length, 1);
  await f.step(1_000);
  assert.equal(f.state.sent.length, 2, 'sent once the batch is 30 seconds old');
  assert.deepEqual(f.state.sent[1].sessions.map((s) => s.state), ['running']);

  f.state.busy = [claude('a', 'waiting', { waitingKind: 'permission' })];
  await f.step(1_000);
  assert.equal(f.state.sent.length, 2, 'merged for two seconds');
  await f.step(2_000);
  assert.equal(f.state.sent.length, 3);
  assert.deepEqual(f.state.sent[2].sessions, [{
    sessionId: 'a', provider: 'claude', state: 'waiting', waitingKind: 'permission', since: f.state.now - 2_000, lastActivity: f.state.now - 2_000,
  }]);
  assert.equal(f.state.sent[2].full, false);
});

test('a session that goes quiet is reported idle with how its turn ended; a failure is urgent', async () => {
  const f = fixture();
  f.state.busy = [claude('ok', 'running'), claude('bad', 'running'), claude('bg', 'running')];
  await f.step();
  f.state.busy = [claude('bg', 'background')];
  f.state.outcomes.set('bad', 'failed');
  await f.step(5_000);
  await f.step(2_000);
  assert.equal(f.state.sent.length, 2, 'the failure did not wait for the batch');
  const byId = Object.fromEntries(f.state.sent[1].sessions.map((s) => [s.sessionId, s]));
  assert.deepEqual([byId.ok.state, byId.ok.outcome, byId.ok.turnEndedAt], ['idle', 'completed', 1_005_000]);
  assert.deepEqual([byId.bad.state, byId.bad.outcome], ['idle', 'failed']);
  assert.deepEqual([byId.bg.state, byId.bg.outcome, byId.bg.turnEndedAt], ['background', 'completed', 1_005_000],
    'a turn that left background work behind has ended too');

  f.state.busy = [];
  await f.step(1_000);
  await f.step(30_000);
  assert.equal(f.state.sent.length, 3);
  const last = f.state.sent.at(-1)!;
  assert.deepEqual(last.sessions.map((s) => [s.sessionId, s.state, s.turnEndedAt]), [['bg', 'idle', undefined]],
    'when the background work ends there is no new turn ending');
});

test('a quiet machine sends a heartbeat, and the Portal\'s parameters take effect', async () => {
  const f = fixture();
  f.state.reply.settings.values = {
    batchMs: 10_000, heartbeatMs: 60_000, urgentMergeMs: 0, settleMs: 30_000, summaryConcurrency: 1, nope: 5,
  };
  await f.step();
  assert.deepEqual(f.reporter.currentSettings, {
    urgentMergeMs: 0, batchMs: 10_000, batchSessions: 20, heartbeatMs: 60_000, scanMs: 5_000,
    settleMs: 30_000, summaryTurns: 3, summaryMs: 600_000, summaryMinIntervalMs: 60_000, summaryConcurrency: 1,
  });
  await f.step(59_000);
  assert.equal(f.state.sent.length, 1);
  await f.step(1_000);
  assert.equal(f.state.sent.length, 2);
  assert.deepEqual(f.state.sent[1].sessions, [], 'a heartbeat lists nothing');
  f.state.busy = [claude('a', 'running')];
  await f.step(10_000);
  await f.step(10_000);
  assert.equal(f.state.sent.length, 3, 'the shorter batch time applies');
});

test('a failed report is retried unchanged; changes meanwhile go in the next one', async () => {
  const f = fixture();
  await f.step();
  f.state.busy = [claude('a', 'waiting')];
  f.state.fail = {};
  await f.step(1_000);
  await f.step(2_000);
  assert.equal(f.state.sent.length, 1, 'the Portal could not be reached');
  f.state.busy = [claude('a', 'waiting'), claude('b', 'waiting')];
  f.state.fail = null;
  await f.step(14_000);
  assert.equal(f.state.sent.length, 1, 'backs off fifteen seconds');
  await f.step(1_000);
  assert.equal(f.state.sent.length, 2);
  assert.deepEqual([f.state.sent[1].seq, f.state.sent[1].sessions.map((s) => s.sessionId)], [1, ['a']], 'the same report, same sequence');
  await f.step(2_000);
  assert.deepEqual([f.state.sent[2].seq, f.state.sent[2].sessions.map((s) => s.sessionId)], [2, ['b']]);
});

test('a Portal without the route is asked again an hour later, with a full report', async () => {
  const f = fixture();
  f.state.busy = [claude('a', 'running')];
  f.state.fail = { status: 404 };
  await f.step();
  f.state.fail = null;
  await f.step(30 * 60_000);
  assert.equal(f.state.sent.length, 0);
  await f.step(30 * 60_000);
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.sent[0].full, true);
  assert.deepEqual(f.state.sent[0].sessions.map((s) => s.sessionId), ['a']);
});

test('sessions are summarized only while the Portal\'s last reply says it takes summaries', async () => {
  const f = fixture({ summaries: true });
  delete f.state.reply.features;
  f.state.busy = [claude('a', 'running')];
  await f.step();
  f.state.busy = [claude('a', 'waiting', { waitingKind: 'permission' })];
  await f.step(1_000);
  await f.step(2_000);
  assert.equal(f.state.sent.length, 2);
  assert.equal(f.state.summarized.length, 0, 'an older Portal would refuse the field, so nothing is written');

  f.state.reply.features = { summary: true };
  f.state.busy = [claude('a', 'running')];
  await f.step(1_000);
  await f.step(30_000);
  f.state.busy = [claude('a', 'waiting', { waitingKind: 'question' })];
  await f.step(1_000);
  assert.deepEqual(f.state.summarized.map((request) => [request.reason, request.waitingKind]), [['waiting', 'question']]);
  await f.step(2_000);
  assert.deepEqual(f.summariesSent(), [['a', 'waiting', 'waiting a']]);

  delete f.state.reply.features;
  f.state.busy = [claude('a', 'running')];
  await f.step(1_000);
  await f.step(30_000);
  f.state.busy = [claude('a', 'waiting')];
  await f.step(1_000);
  assert.equal(f.state.summarized.length, 1, 'a Portal that stops saying so gets no more');
});

test('waiting summaries go out within seconds; a settled one rides the next batch on the state last reported', async () => {
  const f = fixture({ summaries: true });
  f.state.busy = [claude('a', 'running')];
  await f.step();
  f.state.busy = [claude('a', 'waiting', { waitingKind: 'permission' })];
  await f.step(1_000);
  assert.equal(f.state.sent.length, 1);
  await f.step(2_000);
  assert.equal(f.state.sent.length, 2);
  const waitingAt = f.state.now - 2_000;
  assert.deepEqual(f.state.sent[1].sessions, [{
    sessionId: 'a', provider: 'claude', state: 'waiting', waitingKind: 'permission', since: waitingAt, lastActivity: waitingAt,
    summary: { text: 'waiting a', reason: 'waiting', at: waitingAt },
  }], 'the summary rides on the change it describes');

  f.state.busy = [];
  await f.step(5_000);
  const idleAt = f.state.now;
  await f.step(30_000);
  assert.equal(f.state.sent.length, 3);
  assert.deepEqual([f.state.sent[2].sessions[0].state, f.state.sent[2].sessions[0].summary], ['idle', undefined]);
  await f.step(30_000);
  assert.deepEqual(f.state.summarized.map((request) => request.reason), ['waiting', 'settled'], 'a minute after the turn ended');
  assert.equal(f.state.sent.length, 3, 'an ordinary summary waits for the batch');
  await f.step(30_000);
  assert.equal(f.state.sent.length, 4);
  assert.deepEqual(f.state.sent[3].sessions, [{
    sessionId: 'a', provider: 'claude', state: 'idle', since: idleAt, lastActivity: idleAt,
    summary: { text: 'settled a', reason: 'settled', at: idleAt + 60_000 },
  }], 'the session goes along as last reported, without its turn ending again');
  await f.step(5 * 60_000);
  assert.equal(f.state.sent.length, 5);
  assert.equal(f.summariesSent().length, 2, 'each summary is sent once');
});

test('a session that asks something else while it waits is summarized again; one that keeps waiting is not', async () => {
  const f = fixture({ summaries: true });
  f.state.busy = [claude('a', 'running')];
  await f.step();
  f.state.busy = [claude('a', 'waiting', { waitingKind: 'permission' })];
  await f.step(1_000);
  f.state.busy = [claude('a', 'waiting', { waitingKind: 'question' })];
  await f.step(5_000);
  await f.step(5_000);
  await f.step(5 * 60_000);
  assert.deepEqual(f.state.summarized.map((request) => [request.reason, request.waitingKind]),
    [['waiting', 'permission'], ['waiting', 'question']]);
});

test('a report the Portal refuses for its summaries goes again at once without them, and they are dropped', async () => {
  for (const status of [400, 413]) {
    const f = fixture({ summaries: true });
    f.state.busy = [claude('a', 'running'), claude('c', 'running')];
    await f.step();
    f.state.busy = [claude('a', 'running')];
    await f.step(1_000);
    await f.step(30_000);
    await f.step(30_000);
    assert.deepEqual(f.state.summarized.map((request) => [request.sessionId, request.reason]), [['c', 'settled']]);
    f.state.busy = [claude('a', 'waiting')];
    await f.step(1_000);
    f.state.refuseSummaries = status;
    await f.step(2_000);
    assert.equal(f.state.sent.length, 3);
    const retried = f.state.sent[2];
    assert.equal(retried.seq, 2, 'the same sequence number as the refused report');
    assert.deepEqual(retried.sessions.map((session) => [session.sessionId, session.state, session.summary]), [['a', 'waiting', undefined]],
      `${status}: no summaries, and no session listed only for one`);
    f.state.refuseSummaries = null;
    await f.step(60_000);
    await f.step(5 * 60_000);
    assert.deepEqual(f.summariesSent(), [], 'the refused summaries are not sent again');
  }
});

test('a report carries at most 40 summaries; the rest go in the next one', async () => {
  const f = fixture({ summaries: true });
  await f.step();
  const ids = Array.from({ length: 45 }, (_, index) => `s${index}`);
  f.state.busy = ids.slice(0, 30).map((id) => claude(id, 'waiting'));
  await f.step(1_000);
  f.state.busy = ids.map((id) => claude(id, 'waiting'));
  await f.step(500);
  assert.equal(f.state.summarized.length, 45);
  assert.equal(f.state.sent.length, 2, 'thirty changes went at once, before their summaries were written');
  await f.step(1_500);
  await f.step(2_000);
  assert.equal(f.state.sent.length, 4);
  const counts = f.state.sent.slice(2).map((report) => report.sessions.filter((session) => session.summary).length);
  assert.deepEqual(counts, [40, 5]);
  assert.deepEqual(new Set(f.summariesSent().map(([sessionId]) => sessionId)), new Set(ids), 'every summary once');
  assert.equal(f.state.sent[2].sessions.length, 45, 'fifteen changes and thirty sessions listed for their summary');
});

test('a Portal without the route drops the summaries not yet sent', async () => {
  const f = fixture({ summaries: true });
  f.state.busy = [claude('a', 'running')];
  await f.step();
  f.state.busy = [claude('a', 'waiting')];
  await f.step(1_000);
  assert.equal(f.state.summarized.length, 1);
  f.state.fail = { status: 404 };
  await f.step(2_000);
  f.state.fail = null;
  await f.step(60 * 60_000);
  assert.equal(f.state.sent.length, 2);
  assert.equal(f.state.sent[1].full, true);
  assert.deepEqual(f.summariesSent(), []);
});

test('the run registry tells listeners when runs start and end, and remembers how each ended', async () => {
  const { chatRunRegistry } = await import('@/modules/websocket/index.js');
  chatRunRegistry.clearAll();
  const changes: string[] = [];
  const unsubscribe = chatRunRegistry.onChange((sessionId) => changes.push(sessionId));
  try {
    for (const [sessionId, opts, outcome] of [
      ['ok', { exitCode: 0 }, 'completed'],
      ['bad', { exitCode: 1 }, 'failed'],
      ['stopped', { exitCode: 0, aborted: true }, 'interrupted'],
    ] as const) {
      chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: null });
      assert.equal(chatRunRegistry.getRun(sessionId)?.outcome, null);
      chatRunRegistry.completeRun(sessionId, opts);
      assert.equal(chatRunRegistry.getRun(sessionId)?.outcome, outcome);
    }
    assert.deepEqual(changes, ['ok', 'ok', 'bad', 'bad', 'stopped', 'stopped']);
  } finally {
    unsubscribe();
    chatRunRegistry.clearAll();
  }
});
