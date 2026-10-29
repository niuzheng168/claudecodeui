import type { SessionSummary, SessionSummaryRequest } from '@/shared/index.js';

/**
 * Decides when each session gets its one-line summary
 * (docs/codey-project-overview-design.md §9.2), and writes them a few at a time.
 *
 * The activity reporter says what changed in each session at every scan. A
 * session that starts waiting for its user, or whose turn fails, is summarized
 * at once. When a turn ends otherwise the session may be settling: if no new
 * turn begins within `settleMs`, the turns since its last summary are
 * summarized. A session whose turns keep following each other within
 * `settleMs` never settles, so it is summarized at the end of a turn once
 * `summaryTurns` turns or `summaryMs` have gone by since the first of them.
 * Apart from waiting and failures, one session is summarized at most once per
 * `summaryMinIntervalMs`.
 *
 * At most `summaryConcurrency` summaries are written at once, with up to 32
 * more waiting (waiting and failures first), each within 30 seconds and never
 * retried. While the Portal does not take summaries, nothing is written.
 */

/** The Portal's parameters, read at every use so a change applies at once. */
type SummarySettings = {
  settleMs: number;
  summaryTurns: number;
  summaryMs: number;
  summaryMinIntervalMs: number;
  summaryConcurrency: number;
};

/** What the reporter saw change in one session at a scan. */
type SessionChange = {
  sessionId: string;
  provider: 'claude' | 'codex';
  /** A turn is going on: the session runs, or waits for its user. */
  busy: boolean;
  /** A turn began, at about this time. */
  turnStartedAt?: number;
  /** It began waiting for its user, for this when known. */
  waiting?: { kind?: 'permission' | 'question' };
  /** A turn ended, on an error when `failed`. */
  turnEnded?: { failed: boolean };
};

type SchedulerDependencies = {
  /** Writes one summary, or null when there is nothing to say; stops when `signal` aborts. */
  summarize(request: SessionSummaryRequest, signal: AbortSignal): Promise<string | null>;
  /** Hands a written summary over to be reported. */
  deliver(sessionId: string, summary: SessionSummary): void;
  settings(): SummarySettings;
  now(): number;
  warn?(message: string): void;
  /** How long one summary may take: 30 seconds unless a test says otherwise. */
  timeoutMs?: number;
};

/** One session's turns since its last summary, and which summary is due. */
type TrackedSession = {
  provider: 'claude' | 'codex';
  busy: boolean;
  /** When the first turn not yet summarized began. */
  segmentStartedAt: number | null;
  /** Turns ended since the last summary of what they did. */
  turns: number;
  lastTurnEndedAt: number | null;
  /** The current turn began within `settleMs` of the previous one's end. */
  chained: boolean;
  lastSummaryAt: number | null;
  /** Due at once, whatever the interval since the last summary. */
  urgent: { reason: 'waiting' | 'failed'; at: number; waitingKind?: 'permission' | 'question' } | null;
  /** A chained turn ended with enough turns or time behind it. */
  continuousAt: number | null;
  /** The session has settled if no turn starts before this time. */
  settleAt: number | null;
  changedAt: number;
};

type SummaryJob = SessionSummaryRequest & { urgent: boolean };

const MAX_QUEUED = 32;
const DEFAULT_TIMEOUT_MS = 30_000;
/** A quiet session is forgotten after this long; neither the interval nor the settle time can be longer. */
const FORGET_AFTER_MS = 2 * 60 * 60_000;
const MAX_TRACKED = 2_000;
const UNAVAILABLE = '[Activity] A session summary could not be written; the session is unaffected.';

/** Used by the activity reporter, which owns one per machine; tests drive it with a fake clock. */
export class SessionSummaryScheduler {
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly queue: SummaryJob[] = [];
  private active = 0;

  constructor(private readonly deps: SchedulerDependencies) {}

  /** Notes one change: a turn starting or ending, or the session starting to wait for its user. */
  observe(change: SessionChange): void {
    const now = this.deps.now();
    const settings = this.deps.settings();
    const session: TrackedSession = this.tracked.get(change.sessionId) ?? {
      provider: change.provider, busy: false, segmentStartedAt: null, turns: 0, lastTurnEndedAt: null,
      chained: false, lastSummaryAt: null, urgent: null, continuousAt: null, settleAt: null, changedAt: now,
    };
    // Most recently changed last, so the oldest is the one forgotten first.
    this.tracked.delete(change.sessionId);
    this.tracked.set(change.sessionId, session);
    if (this.tracked.size > MAX_TRACKED) this.tracked.delete(this.tracked.keys().next().value!);
    session.provider = change.provider;
    session.busy = change.busy;
    session.changedAt = now;

    if (change.turnStartedAt !== undefined) {
      session.chained = session.lastTurnEndedAt !== null
        && change.turnStartedAt - session.lastTurnEndedAt < settings.settleMs;
      session.settleAt = null;
      session.segmentStartedAt ??= change.turnStartedAt;
    }
    if (change.waiting) {
      session.urgent = { reason: 'waiting', at: now, ...(change.waiting.kind ? { waitingKind: change.waiting.kind } : {}) };
    }
    if (change.turnEnded) {
      session.turns += 1;
      session.lastTurnEndedAt = now;
      // A turn that started and ended between two scans began about now.
      session.segmentStartedAt ??= now;
      if (change.turnEnded.failed) {
        session.urgent = { reason: 'failed', at: now };
      } else {
        session.settleAt = now + settings.settleMs;
        if (session.chained && (session.turns >= settings.summaryTurns
          || now - session.segmentStartedAt >= settings.summaryMs)) {
          session.continuousAt = now;
        }
      }
    }
  }

  /**
   * Queues the summaries that are due and starts as many as the concurrency
   * allows. While the Portal does not take summaries (`enabled` false), what
   * comes due is dropped instead, and nothing waiting is started.
   */
  poll(enabled: boolean): void {
    const now = this.deps.now();
    const settings = this.deps.settings();
    for (const [sessionId, session] of this.tracked) {
      if (enabled) {
        this.takeDue(sessionId, session, now, settings);
      } else {
        session.urgent = null;
        session.continuousAt = null;
        if (session.settleAt !== null && now >= session.settleAt) session.settleAt = null;
      }
      if (!session.busy && !session.urgent && session.continuousAt === null && session.settleAt === null
        && now - session.changedAt > FORGET_AFTER_MS) {
        this.tracked.delete(sessionId);
      }
    }
    if (!enabled) this.queue.length = 0;
    this.drain();
  }

  /** Drops the summaries not yet started, once the Portal no longer takes them. */
  clear(): void {
    this.queue.length = 0;
  }

  private takeDue(sessionId: string, session: TrackedSession, now: number, settings: SummarySettings): void {
    const base = { sessionId, provider: session.provider, segmentStartedAt: session.segmentStartedAt ?? now };
    if (session.urgent) {
      const { reason, at, waitingKind } = session.urgent;
      session.urgent = null;
      session.lastSummaryAt = now;
      this.enqueue({
        ...base, reason, at, urgent: true,
        ...(waitingKind ? { waitingKind } : {}),
        ...(reason === 'failed' ? { turnEndedAt: session.lastTurnEndedAt ?? at } : {}),
      });
      // A failure ends what these turns did: there is nothing left to settle.
      if (reason === 'failed') startSegment(session);
      return;
    }

    const intervalPassed = session.lastSummaryAt === null || now - session.lastSummaryAt >= settings.summaryMinIntervalMs;
    if (session.continuousAt !== null) {
      const at = session.continuousAt;
      session.continuousAt = null;
      // Too soon after the last summary: the next turn's end, or settling, looks again.
      if (!intervalPassed) return;
      this.enqueue({ ...base, reason: 'continuous', at, turnEndedAt: session.lastTurnEndedAt ?? at, urgent: false });
      session.lastSummaryAt = now;
      startSegment(session);
      return;
    }

    if (session.settleAt === null || now < session.settleAt || session.busy || session.turns === 0) return;
    if (!intervalPassed) {
      session.settleAt = session.lastSummaryAt! + settings.summaryMinIntervalMs;
      return;
    }
    this.enqueue({ ...base, reason: 'settled', at: now, turnEndedAt: session.lastTurnEndedAt ?? now, urgent: false });
    session.lastSummaryAt = now;
    startSegment(session);
  }

  private enqueue(job: SummaryJob): void {
    // A newer summary of a session replaces one still waiting for its turn.
    const queued = this.queue.findIndex((entry) => entry.sessionId === job.sessionId);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (this.queue.length >= MAX_QUEUED) {
      // Full: waiting or a failure pushes out the oldest ordinary summary; an ordinary one is dropped.
      const ordinary = this.queue.findIndex((entry) => !entry.urgent);
      if (!job.urgent || ordinary < 0) return;
      this.queue.splice(ordinary, 1);
    }
    // Waiting and failures go ahead of the others, in the order they came.
    const firstOrdinary = job.urgent ? this.queue.findIndex((entry) => !entry.urgent) : -1;
    if (firstOrdinary < 0) this.queue.push(job);
    else this.queue.splice(firstOrdinary, 0, job);
  }

  private drain(): void {
    const limit = Math.max(1, this.deps.settings().summaryConcurrency);
    while (this.active < limit && this.queue.length) this.start(this.queue.shift()!);
  }

  private start(job: SummaryJob): void {
    const { urgent: _urgent, ...request } = job;
    this.active += 1;
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', finish);
      this.active -= 1;
      this.drain();
    };
    // The deadline frees the slot even when the generator is slow to stop.
    signal.addEventListener('abort', finish);
    this.deps.summarize(request, signal).then((text) => {
      if (text && !signal.aborted) this.deps.deliver(request.sessionId, { text, reason: request.reason, at: request.at });
    }, () => {
      // Never log the conversation, the prompt or the model's answer.
      this.deps.warn?.(UNAVAILABLE);
    }).finally(finish);
  }
}

/** The next summary covers the turns from the next one on. */
function startSegment(session: TrackedSession): void {
  session.turns = 0;
  session.segmentStartedAt = null;
  session.settleAt = null;
  session.continuousAt = null;
}
