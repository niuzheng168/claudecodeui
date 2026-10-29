import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { sessionsDb } from '@/modules/database/index.js';
import { codexThreadStatus, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { generateSessionSummary } from '@/modules/activity/services/session-summary-generator.service.js';
import { SessionSummaryScheduler } from '@/modules/activity/services/session-summary-scheduler.service.js';
import type { SessionSummary, SessionSummaryRequest } from '@/shared/index.js';

/**
 * Tells the Codey Portal how this machine's sessions are doing, so the
 * Workbench overview and notifications work without any page open and
 * without the Portal asking each machine (docs/codey-project-overview-design.md §4.1).
 *
 * Every few seconds it looks at the sessions locally — the same view as
 * `GET /api/providers/sessions/running` — and keeps what changed. A session
 * that starts waiting for its user, or whose turn failed, is sent within
 * seconds; everything else waits for a batch. A machine with nothing to say
 * still sends a heartbeat now and then. Only installed Codey nodes report:
 * the codey package names its signed Portal client in CODEY_PORTAL_CLIENT_MODULE.
 *
 * Once the Portal's reply says it takes them (`features.summary`), sessions
 * also carry one-line summaries (§9): written when a session starts waiting
 * or fails, when it settles, and now and then while it keeps running, then
 * sent with the next report and forgotten once the Portal has them.
 */

export type ActivityState = 'running' | 'waiting' | 'background' | 'idle';
export type ActivityOutcome = 'completed' | 'failed' | 'interrupted';
export type WaitingKind = 'permission' | 'question';

/** A session that is not idle right now, as seen on this machine. */
export type ObservedSession = {
  sessionId: string;
  provider: 'claude' | 'codex';
  state: Exclude<ActivityState, 'idle'>;
  waitingKind?: WaitingKind;
  /** When its current turn or background work began, if known. */
  startedAt?: number;
};

export type ReportedSession = {
  sessionId: string;
  provider: 'claude' | 'codex';
  state: ActivityState;
  waitingKind?: WaitingKind;
  since: number;
  lastActivity: number;
  turnEndedAt?: number;
  outcome?: ActivityOutcome;
  /** A summary written since the last report, sent only to a Portal that takes them. */
  summary?: SessionSummary;
};

export type ActivityReport = {
  boot: string;
  seq: number;
  full: boolean;
  version?: string;
  sessions: ReportedSession[];
};

export type ReporterSettings = {
  urgentMergeMs: number;
  batchMs: number;
  batchSessions: number;
  heartbeatMs: number;
  scanMs: number;
  /** A turn followed by no other for this long has settled (§9.2). */
  settleMs: number;
  /** A session that keeps running is summarized every this many turns... */
  summaryTurns: number;
  /** ...or this long, whichever comes first. */
  summaryMs: number;
  /** Two summaries of one session, other than waiting and failures, are at least this far apart. */
  summaryMinIntervalMs: number;
  /** Summaries written at once on this machine. */
  summaryConcurrency: number;
};

export const DEFAULT_REPORTER_SETTINGS: ReporterSettings = Object.freeze({
  urgentMergeMs: 2_000,
  batchMs: 30_000,
  batchSessions: 20,
  heartbeatMs: 5 * 60_000,
  scanMs: 5_000,
  settleMs: 60_000,
  summaryTurns: 3,
  summaryMs: 10 * 60_000,
  summaryMinIntervalMs: 60_000,
  summaryConcurrency: 2,
});

export type ReporterDependencies = {
  /** The sessions that are not idle right now. */
  observe(): Promise<ObservedSession[]>;
  /** How the session's last CloudCLI run ended, when CloudCLI ran it. */
  outcomeOf(sessionId: string): ActivityOutcome | null;
  /** Sends one report to the Portal; rejects with `status` set when the Portal answered with an error. */
  send(report: ActivityReport): Promise<unknown>;
  /** Writes one session's summary line, or null when there is nothing to say. Without it nothing is summarized. */
  summarize?(request: SessionSummaryRequest, signal: AbortSignal): Promise<string | null>;
  now(): number;
  version?: string;
};

/** The Portal does not have the route, or does not take reports from this machine: ask again much later. */
const REFUSED_STATUSES = new Set([401, 403, 404, 405]);
/** The Portal could not take the report as it was: one carrying summaries goes again without them. */
const UNACCEPTABLE_STATUSES = new Set([400, 413]);
const REFUSED_PAUSE_MS = 60 * 60_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
const MAX_REPORT_SESSIONS = 200;
/** The Portal takes request bodies of up to 64 KiB, so one report carries at most this many summaries. */
const MAX_REPORT_SUMMARIES = 40;
/** Summaries waiting while the Portal cannot be reached; beyond this the oldest go. */
const MAX_UNSENT_SUMMARIES = 200;
/** How long a session's idle state is remembered for a summary still to come. */
const IDLE_MEMORY_MS = 2 * 60 * 60_000;

type UnsentSummary = { sessionId: string; summary: SessionSummary };

const isUrgentSummary = ({ summary }: UnsentSummary) => summary.reason === 'waiting' || summary.reason === 'failed';

/** The same report without its summaries, and without the sessions it listed only to carry one. */
function withoutSummaries(report: ActivityReport, carriers: Set<string>): ActivityReport {
  return {
    ...report,
    sessions: report.sessions
      .filter((session) => !carriers.has(session.sessionId))
      .map(({ summary: _summary, ...session }) => session),
  };
}

function readSettings(current: ReporterSettings, value: unknown): ReporterSettings {
  const values = (value as { values?: Record<string, unknown> } | null)?.values;
  if (!values || typeof values !== 'object') return current;
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_REPORTER_SETTINGS) as Array<keyof ReporterSettings>) {
    const entry = values[key];
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) next[key] = entry;
  }
  return next;
}

export class ActivityReporter {
  /** Sessions last seen busy, with when that state began. */
  private readonly busy = new Map<string, ReportedSession>();
  /** Changes not yet handed to a report. */
  private readonly pending = new Map<string, ReportedSession>();
  private readonly boot = randomBytes(12).toString('base64url');
  private seq = 0;
  private needFull = true;
  private settings: ReporterSettings = { ...DEFAULT_REPORTER_SETTINGS };
  private inflight: ActivityReport | null = null;
  private failures = 0;
  private retryAt = 0;
  private pausedUntil = 0;
  private lastSentAt = 0;
  private batchStartedAt: number | null = null;
  private urgentAt: number | null = null;
  private sending = false;
  /** Sessions gone idle lately, as reported: a summary of one still rides on its state. */
  private readonly idle = new Map<string, ReportedSession>();
  /** Summaries not yet handed to a report, oldest first. */
  private unsentSummaries: UnsentSummary[] = [];
  /** The sessions the report in flight lists only for their summary; null when it carries no summary. */
  private inflightCarriers: Set<string> | null = null;
  /** The Portal's last reply said it takes summaries; nothing is summarized until one does. */
  private summariesAccepted = false;
  private readonly summaryScheduler: SessionSummaryScheduler | null;

  constructor(private readonly deps: ReporterDependencies) {
    this.summaryScheduler = deps.summarize
      ? new SessionSummaryScheduler({
        summarize: deps.summarize,
        deliver: (sessionId, summary) => this.keepSummary(sessionId, summary),
        settings: () => this.settings,
        now: deps.now,
        warn: (message) => console.warn(message),
      })
      : null;
  }

  get currentSettings(): ReporterSettings {
    return this.settings;
  }

  /** Compares what is busy now with what was busy at the last scan and keeps the differences. */
  async scan(): Promise<void> {
    const observed = await this.deps.observe();
    const now = this.deps.now();
    const seen = new Set<string>();
    for (const entry of observed) {
      seen.add(entry.sessionId);
      const previous = this.busy.get(entry.sessionId);
      if (previous && previous.state === entry.state && previous.waitingKind === entry.waitingKind) continue;
      const next: ReportedSession = {
        sessionId: entry.sessionId,
        provider: entry.provider,
        state: entry.state,
        ...(entry.waitingKind ? { waitingKind: entry.waitingKind } : {}),
        since: !previous && entry.startedAt && entry.startedAt <= now ? entry.startedAt : now,
        lastActivity: now,
      };
      // Running → background: the turn ended and left agents or scheduled tasks behind.
      if (previous?.state === 'running' && entry.state === 'background') {
        next.turnEndedAt = now;
        next.outcome = this.deps.outcomeOf(entry.sessionId) ?? 'completed';
      }
      this.busy.set(entry.sessionId, next);
      this.idle.delete(entry.sessionId);
      this.keep(next, entry.state === 'waiting' || next.outcome === 'failed', now);
      this.noteForSummaries(previous, next, entry.startedAt, now);
    }
    for (const [sessionId, previous] of this.busy) {
      if (seen.has(sessionId)) continue;
      this.busy.delete(sessionId);
      const next: ReportedSession = {
        sessionId, provider: previous.provider, state: 'idle', since: now, lastActivity: now,
      };
      // Background → idle: the turn had already ended when its work went to the background.
      if (previous.state !== 'background') {
        next.turnEndedAt = now;
        next.outcome = this.deps.outcomeOf(sessionId) ?? 'completed';
      }
      if (this.summaryScheduler) this.idle.set(sessionId, next);
      this.keep(next, next.outcome === 'failed', now);
      this.noteForSummaries(previous, next, undefined, now);
    }
  }

  private keep(session: ReportedSession, urgent: boolean, now: number): void {
    this.pending.set(session.sessionId, session);
    this.batchStartedAt ??= now;
    if (urgent) this.urgentAt = Math.min(this.urgentAt ?? Infinity, now + this.settings.urgentMergeMs);
  }

  /**
   * Tells the summary scheduler what a change means: a turn starting or
   * ending, or a new prompt for the user (waiting begins, or asks another kind of thing).
   */
  private noteForSummaries(
    previous: ReportedSession | undefined,
    next: ReportedSession,
    startedAt: number | undefined,
    now: number,
  ): void {
    if (!this.summaryScheduler) return;
    const from = previous?.state ?? 'idle';
    const busy = next.state === 'running' || next.state === 'waiting';
    // Only a start just reported is the turn's own: a Claude CLI's record can
    // say when its process started instead.
    const turnStartedAt = startedAt !== undefined && startedAt <= now && now - startedAt <= 2 * this.settings.scanMs
      ? startedAt
      : now;
    const newPrompt = next.state === 'waiting' && (from !== 'waiting' || previous?.waitingKind !== next.waitingKind);
    this.summaryScheduler.observe({
      sessionId: next.sessionId,
      provider: next.provider,
      busy,
      ...(busy && (from === 'idle' || from === 'background') ? { turnStartedAt } : {}),
      ...(newPrompt ? { waiting: { kind: next.waitingKind } } : {}),
      ...(next.turnEndedAt !== undefined ? { turnEnded: { failed: next.outcome === 'failed' } } : {}),
    });
  }

  /** A written summary to report: waiting and failures within `urgentMergeMs`, the others with the next batch. */
  private keepSummary(sessionId: string, summary: SessionSummary): void {
    if (!this.summariesAccepted) return;
    const unsent = { sessionId, summary };
    this.unsentSummaries.push(unsent);
    if (this.unsentSummaries.length > MAX_UNSENT_SUMMARIES) {
      this.unsentSummaries.splice(0, this.unsentSummaries.length - MAX_UNSENT_SUMMARIES);
    }
    const now = this.deps.now();
    this.batchStartedAt ??= now;
    if (isUrgentSummary(unsent)) this.urgentAt = Math.min(this.urgentAt ?? Infinity, now + this.settings.urgentMergeMs);
  }

  /**
   * Starts the summaries that have come due, once the Portal takes them
   * (§9.2), and forgets sessions idle for too long to get one. Called on
   * every tick, after that tick's scan and send.
   */
  pollSummaries(): void {
    if (!this.summaryScheduler) return;
    const now = this.deps.now();
    for (const [sessionId, session] of this.idle) {
      if (now - session.since > IDLE_MEMORY_MS) this.idle.delete(sessionId);
    }
    this.summaryScheduler.poll(this.summariesAccepted);
  }

  /** When the next report should go out. */
  dueAt(): number {
    if (this.deps.now() < this.pausedUntil) return this.pausedUntil;
    if (this.inflight) return this.retryAt;
    const due = [this.lastSentAt + this.settings.heartbeatMs];
    if (this.needFull) due.push(0);
    if (this.pending.size || this.unsentSummaries.length) {
      if (this.urgentAt !== null) due.push(this.urgentAt);
      if (this.batchStartedAt !== null) due.push(this.batchStartedAt + this.settings.batchMs);
      if (this.pending.size >= this.settings.batchSessions) due.push(0);
    }
    return Math.min(...due);
  }

  /**
   * Sends one report. A failed report is sent again unchanged, with the same
   * sequence number, so the Portal applies it at most once; changes made
   * meanwhile wait for the next one. After a restart or a refusal the first
   * report lists every busy session (`full`), and the Portal idles the rest.
   * A report whose summaries the Portal will not take (400, 413) goes again at
   * once without them, and they are dropped.
   */
  async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      this.inflight ??= this.nextReport();
      for (;;) {
        const report = this.inflight;
        try {
          const reply = await this.deps.send(report) as { settings?: unknown; features?: { summary?: unknown } } | null;
          this.inflight = null;
          this.inflightCarriers = null;
          this.failures = 0;
          this.lastSentAt = this.deps.now();
          this.settings = readSettings(this.settings, reply?.settings);
          this.acceptSummaries(reply?.features?.summary === true);
          return;
        } catch (error) {
          const status = (error as { status?: unknown })?.status;
          if (typeof status === 'number' && UNACCEPTABLE_STATUSES.has(status) && this.inflightCarriers) {
            // The same sequence number: the Portal applied nothing of the refused report.
            this.inflight = withoutSummaries(report, this.inflightCarriers);
            this.inflightCarriers = null;
            continue;
          }
          if (typeof status === 'number' && REFUSED_STATUSES.has(status)) {
            // An older Portal, or a machine it does not take reports from. Start over later.
            this.inflight = null;
            this.inflightCarriers = null;
            this.needFull = true;
            this.pausedUntil = this.deps.now() + REFUSED_PAUSE_MS;
            this.acceptSummaries(false);
            return;
          }
          this.failures += 1;
          this.retryAt = this.deps.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  /** The next report: the changes kept since the last one, with the summaries that fit. */
  private nextReport(): ActivityReport {
    const changes = [...this.pending.values()];
    const full = this.needFull;
    const sessions = full
      ? [...this.busy.values(), ...changes.filter((session) => session.state === 'idle')]
      : changes;
    const report: ActivityReport = {
      boot: this.boot,
      seq: this.seq++,
      // Too many busy sessions for one report: send them without idling the others.
      full: full && sessions.length <= MAX_REPORT_SESSIONS,
      ...(this.deps.version ? { version: this.deps.version } : {}),
      sessions: this.attachSummaries(sessions.slice(0, MAX_REPORT_SESSIONS)),
    };
    this.pending.clear();
    for (const session of sessions.slice(MAX_REPORT_SESSIONS)) this.pending.set(session.sessionId, session);
    this.needFull = false;
    const now = this.deps.now();
    this.batchStartedAt = this.pending.size || this.unsentSummaries.length ? now : null;
    this.urgentAt = this.unsentSummaries.some(isUrgentSummary) ? now + this.settings.urgentMergeMs : null;
    return report;
  }

  /**
   * Puts up to 40 summaries, at most one per session, on the report's
   * sessions. A session the report does not list goes along with the state it
   * was last reported in. The rest wait for the next report.
   */
  private attachSummaries(listed: ReportedSession[]): ReportedSession[] {
    this.inflightCarriers = null;
    if (!this.summariesAccepted || !this.unsentSummaries.length) return listed;
    const sessions = [...listed];
    const positions = new Map(sessions.map((session, index) => [session.sessionId, index]));
    const carriers = new Set<string>();
    const attached = new Set<string>();
    const left: UnsentSummary[] = [];
    for (const unsent of this.unsentSummaries) {
      if (attached.size >= MAX_REPORT_SUMMARIES || attached.has(unsent.sessionId)) {
        left.push(unsent);
        continue;
      }
      let position = positions.get(unsent.sessionId);
      if (position === undefined) {
        const last = this.busy.get(unsent.sessionId) ?? this.idle.get(unsent.sessionId);
        // A session forgotten since has no state for its summary to ride on.
        if (!last) continue;
        if (sessions.length >= MAX_REPORT_SESSIONS) {
          left.push(unsent);
          continue;
        }
        // Its state as last reported; how its turn ended went with that report.
        position = sessions.push({
          sessionId: last.sessionId, provider: last.provider, state: last.state,
          ...(last.waitingKind ? { waitingKind: last.waitingKind } : {}),
          since: last.since, lastActivity: last.lastActivity,
        }) - 1;
        positions.set(unsent.sessionId, position);
        carriers.add(unsent.sessionId);
      }
      sessions[position] = { ...sessions[position], summary: unsent.summary };
      attached.add(unsent.sessionId);
    }
    this.unsentSummaries = left;
    if (attached.size) this.inflightCarriers = carriers;
    return sessions;
  }

  /** Follows the Portal's last reply: an older Portal rejects fields it does not know, so it gets no summaries. */
  private acceptSummaries(accepted: boolean): void {
    this.summariesAccepted = accepted;
    if (accepted) return;
    this.unsentSummaries = [];
    this.summaryScheduler?.clear();
  }
}

/** The busy sessions as `GET /api/providers/sessions/running` lists them, with what each waiting one waits for. */
async function observeSessions(): Promise<ObservedSession[]> {
  const observed: ObservedSession[] = [];
  for (const entry of await sessionsService.listRunningSessions()) {
    if (entry.provider !== 'claude' && entry.provider !== 'codex') continue;
    const state = entry.waitingForUser ? 'waiting' : entry.background ? 'background' : 'running';
    observed.push({
      sessionId: entry.sessionId, provider: entry.provider, state,
      // A Claude CLI waiting outside CloudCLI does not say what it asks.
      ...(state === 'waiting' && entry.waitingKind ? { waitingKind: entry.waitingKind } : {}),
      startedAt: entry.startedAt,
    });
  }
  return observed;
}

type PortalRequest = (method: string, pathname: string, options: { body?: unknown }) => Promise<unknown>;

async function loadPortalRequest(): Promise<PortalRequest | null> {
  const modulePath = process.env.CODEY_PORTAL_CLIENT_MODULE;
  if (!modulePath) return null;
  try {
    const loaded = await import(pathToFileURL(modulePath).href) as { portalRequest?: unknown };
    return typeof loaded.portalRequest === 'function' ? loaded.portalRequest as PortalRequest : null;
  } catch (error) {
    console.warn('[Activity] Cannot load the Codey Portal client:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

const TICK_MS = 1_000;
let running: { timer: NodeJS.Timeout; unsubscribe: () => void } | null = null;

/**
 * Starts reporting when CloudCLI runs inside an installed Codey node. A run
 * starting or ending is looked at on the next tick; everything else within
 * `scanMs`. Summaries come due on the tick too.
 */
export async function initializeActivityReporter(): Promise<void> {
  if (running) return;
  const request = await loadPortalRequest();
  if (!request) return;
  const reporter = new ActivityReporter({
    observe: observeSessions,
    outcomeOf: (sessionId) => {
      // A Codex thread that stopped on an error says so whoever ran the turn.
      const session = sessionsDb.getSessionById(sessionId);
      if (session?.provider === 'codex' && session.provider_session_id && codexThreadStatus.outcomeOf(session.provider_session_id)) {
        return 'failed';
      }
      const run = chatRunRegistry.getRun(sessionId);
      return run?.status === 'completed' ? run.outcome : null;
    },
    send: (report) => request('POST', '/api/v1/activity', { body: report }),
    summarize: (summaryRequest, signal) => generateSessionSummary(summaryRequest, signal),
    now: Date.now,
    version: process.env.CODEY_NODE_VERSION || undefined,
  });
  let nextScanAt = 0;
  let busy = false;
  const unsubscribers = [chatRunRegistry, codexThreadStatus].map((source) => source.onChange(() => { nextScanAt = 0; }));
  const unsubscribe = () => unsubscribers.forEach((stop) => stop());
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      if (now >= nextScanAt) {
        nextScanAt = now + reporter.currentSettings.scanMs;
        await reporter.scan();
      }
      if (reporter.dueAt() <= Date.now()) await reporter.flush();
      // After the send: the first reply says whether the Portal takes summaries.
      reporter.pollSummaries();
    } catch (error) {
      console.warn('[Activity] Report failed:', error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  running = { timer, unsubscribe };
  void tick();
}

export function closeActivityReporter(): void {
  if (!running) return;
  clearInterval(running.timer);
  running.unsubscribe();
  running = null;
}
