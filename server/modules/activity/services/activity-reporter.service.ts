import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

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
};

export const DEFAULT_REPORTER_SETTINGS: ReporterSettings = Object.freeze({
  urgentMergeMs: 2_000,
  batchMs: 30_000,
  batchSessions: 20,
  heartbeatMs: 5 * 60_000,
  scanMs: 5_000,
});

export type ReporterDependencies = {
  /** The sessions that are not idle right now. */
  observe(): Promise<ObservedSession[]>;
  /** How the session's last CloudCLI run ended, when CloudCLI ran it. */
  outcomeOf(sessionId: string): ActivityOutcome | null;
  /** Sends one report to the Portal; rejects with `status` set when the Portal answered with an error. */
  send(report: ActivityReport): Promise<unknown>;
  now(): number;
  version?: string;
};

/** The Portal does not have the route, or does not take reports from this machine: ask again much later. */
const REFUSED_STATUSES = new Set([401, 403, 404, 405]);
const REFUSED_PAUSE_MS = 60 * 60_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
const MAX_REPORT_SESSIONS = 200;

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

  constructor(private readonly deps: ReporterDependencies) {}

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
      this.keep(next, entry.state === 'waiting' || next.outcome === 'failed', now);
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
      this.keep(next, next.outcome === 'failed', now);
    }
  }

  private keep(session: ReportedSession, urgent: boolean, now: number): void {
    this.pending.set(session.sessionId, session);
    this.batchStartedAt ??= now;
    if (urgent) this.urgentAt = Math.min(this.urgentAt ?? Infinity, now + this.settings.urgentMergeMs);
  }

  /** When the next report should go out. */
  dueAt(): number {
    if (this.deps.now() < this.pausedUntil) return this.pausedUntil;
    if (this.inflight) return this.retryAt;
    const due = [this.lastSentAt + this.settings.heartbeatMs];
    if (this.needFull) due.push(0);
    if (this.pending.size) {
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
   */
  async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      if (!this.inflight) {
        const changes = [...this.pending.values()];
        const full = this.needFull;
        const sessions = full
          ? [...this.busy.values(), ...changes.filter((session) => session.state === 'idle')]
          : changes;
        this.inflight = {
          boot: this.boot,
          seq: this.seq++,
          // Too many busy sessions for one report: send them without idling the others.
          full: full && sessions.length <= MAX_REPORT_SESSIONS,
          ...(this.deps.version ? { version: this.deps.version } : {}),
          sessions: sessions.slice(0, MAX_REPORT_SESSIONS),
        };
        this.pending.clear();
        for (const session of sessions.slice(MAX_REPORT_SESSIONS)) this.pending.set(session.sessionId, session);
        this.needFull = false;
        this.batchStartedAt = this.pending.size ? this.deps.now() : null;
        this.urgentAt = null;
      }
      const report = this.inflight;
      try {
        const reply = await this.deps.send(report);
        this.inflight = null;
        this.failures = 0;
        this.lastSentAt = this.deps.now();
        this.settings = readSettings(this.settings, (reply as { settings?: unknown } | null)?.settings);
      } catch (error) {
        const status = (error as { status?: unknown })?.status;
        if (typeof status === 'number' && REFUSED_STATUSES.has(status)) {
          // An older Portal, or a machine it does not take reports from. Start over later.
          this.inflight = null;
          this.needFull = true;
          this.pausedUntil = this.deps.now() + REFUSED_PAUSE_MS;
          return;
        }
        this.failures += 1;
        this.retryAt = this.deps.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
      }
    } finally {
      this.sending = false;
    }
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
 * `scanMs`.
 */
export async function initializeActivityReporter(): Promise<void> {
  if (running) return;
  const request = await loadPortalRequest();
  if (!request) return;
  const reporter = new ActivityReporter({
    observe: observeSessions,
    outcomeOf: (sessionId) => {
      const run = chatRunRegistry.getRun(sessionId);
      return run?.status === 'completed' ? run.outcome : null;
    },
    send: (report) => request('POST', '/api/v1/activity', { body: report }),
    now: Date.now,
    version: process.env.CODEY_NODE_VERSION || undefined,
  });
  let nextScanAt = 0;
  let busy = false;
  const unsubscribe = chatRunRegistry.onChange(() => { nextScanAt = 0; });
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
