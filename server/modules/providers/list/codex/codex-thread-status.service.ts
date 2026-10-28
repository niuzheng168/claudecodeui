import { CodexDaemonClient } from '@/modules/providers/list/codex/codex-daemon.client.js';
import type { AnyRecord } from '@/shared/index.js';
import { readObjectRecord } from '@/shared/index.js';

/**
 * Follows every thread of the local Codex app-server daemon — the Codex app's
 * and a terminal's as well as the turns CloudCLI drives there — through one
 * connection that never subscribes to a thread. The daemon tells every
 * connection when a thread turns active, waits on an approval or a question,
 * and goes idle or fails (docs/codey-project-overview-design.md §8.2, checked
 * against codex-cli 0.164.0). CloudCLI's own `codex app-server --stdio` child
 * is a separate process this does not see; its turns are in the chat run
 * registry.
 */

export type CodexWaitingKind = 'permission' | 'question';

/** A thread with a turn in progress. */
export type CodexThreadActivity = {
  threadId: string;
  /** When its turn began, or when this connection first saw it busy. */
  startedAt: number;
  waitingKind?: CodexWaitingKind;
};

type ThreadState = {
  active: boolean;
  startedAt: number;
  waitingKind?: CodexWaitingKind;
  /** The thread stopped on an error (`systemError`). */
  failed: boolean;
};

export type CodexThreadStatusDependencies = {
  connect(): Promise<CodexDaemonClient | null>;
  now(): number;
  /** Waits before connecting again, longer after each failure: no daemon yet (the Codex app not running), or the connection dropped. */
  retryMs: readonly number[];
};

function readStatus(value: unknown, now: number, previous: ThreadState | undefined): ThreadState | null {
  const status = readObjectRecord(value);
  if (status?.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    const waitingKind: CodexWaitingKind | undefined = flags.includes('waitingOnApproval') ? 'permission'
      : flags.includes('waitingOnUserInput') ? 'question' : undefined;
    return { active: true, startedAt: previous?.active ? previous.startedAt : now, ...(waitingKind ? { waitingKind } : {}), failed: false };
  }
  if (status?.type === 'systemError') return { active: false, startedAt: previous?.startedAt ?? now, failed: true };
  // Idle, or no longer loaded: nothing to say about it.
  return null;
}

function sameState(left: ThreadState | undefined, right: ThreadState | null): boolean {
  if (!left || !right) return !left && !right;
  return left.active === right.active && left.waitingKind === right.waitingKind && left.failed === right.failed;
}

export class CodexThreadStatusWatcher {
  /** Threads that are active, or stopped on an error; idle ones are forgotten. */
  private readonly threads = new Map<string, ThreadState>();
  private readonly listeners = new Set<() => void>();
  private client: CodexDaemonClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private failures = 0;

  constructor(private readonly deps: CodexThreadStatusDependencies = {
    connect: () => CodexDaemonClient.connect(),
    now: Date.now,
    retryMs: [5_000, 15_000, 60_000],
  }) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    client?.close();
    this.forgetAll();
  }

  /** Threads with a turn in progress, and what each waiting one waits for. */
  busyThreads(): CodexThreadActivity[] {
    return [...this.threads].filter(([, thread]) => thread.active).map(([threadId, thread]) => ({
      threadId, startedAt: thread.startedAt, ...(thread.waitingKind ? { waitingKind: thread.waitingKind } : {}),
    }));
  }

  /** `failed` when the thread stopped on an error since its last turn began; null when nothing is known. */
  outcomeOf(threadId: string): 'failed' | null {
    return this.threads.get(threadId)?.failed ? 'failed' : null;
  }

  /** Called whenever a thread starts or stops being busy or waiting. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async connect(): Promise<void> {
    this.timer = null;
    let client: CodexDaemonClient | null = null;
    try {
      client = await this.deps.connect();
    } catch (error) {
      if (this.failures === 0) {
        console.warn('[Codex] Cannot follow the Codex app\'s threads:', error instanceof Error ? error.message : String(error));
      }
    }
    if (this.stopped) {
      client?.close();
      return;
    }
    if (!client) {
      this.retry();
      return;
    }
    this.client = client;
    // Statuses that arrive while the loaded threads are read are newer than what the reads say.
    const notified = new Set<string>();
    client.onNotification((method, params) => {
      const threadId = this.handle(method, params);
      if (threadId) notified.add(threadId);
    });
    client.onDisconnect(() => {
      if (this.client !== client) return;
      this.client = null;
      this.forgetAll();
      this.retry();
    });
    try {
      for (const threadId of await this.loadedThreads(client)) {
        if (notified.has(threadId)) continue;
        const read = await client.request('thread/read', { threadId, includeTurns: false });
        if (!notified.has(threadId)) this.apply(threadId, readObjectRecord(read.thread)?.status);
      }
      this.failures = 0;
    } catch {
      // A daemon that cannot answer is dropped; the disconnect above tries again later.
      client.close();
    }
  }

  private async loadedThreads(client: CodexDaemonClient): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await client.request('thread/loaded/list', cursor ? { cursor } : {});
      ids.push(...(Array.isArray(page.data) ? page.data.filter((id): id is string => typeof id === 'string' && id.length > 0) : []));
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    } while (cursor);
    return ids;
  }

  /** Applies one daemon notification; returns the thread whose status it gave, if any. Never throws. */
  private handle(method: string, params: AnyRecord): string | null {
    try {
      if (method === 'thread/status/changed' && typeof params.threadId === 'string') {
        this.apply(params.threadId, params.status);
        return params.threadId;
      }
      const thread = readObjectRecord(params.thread);
      if (method === 'thread/started' && typeof thread?.id === 'string') {
        this.apply(thread.id, thread.status);
        return thread.id;
      }
      if ((method === 'thread/closed' || method === 'thread/deleted' || method === 'thread/archived') && typeof params.threadId === 'string') {
        this.apply(params.threadId, null);
        return params.threadId;
      }
    } catch (error) {
      console.warn('[Codex] Ignored a thread status the daemon sent:', error instanceof Error ? error.message : String(error));
    }
    return null;
  }

  private apply(threadId: string, status: unknown): void {
    const previous = this.threads.get(threadId);
    const next = readStatus(status, this.deps.now(), previous);
    if (sameState(previous, next)) return;
    if (next) this.threads.set(threadId, next);
    else this.threads.delete(threadId);
    this.changed();
  }

  /** The daemon went away: none of its threads can be known to run. */
  private forgetAll(): void {
    if (!this.threads.size) return;
    this.threads.clear();
    this.changed();
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    const { retryMs } = this.deps;
    const delay = retryMs[Math.min(this.failures, retryMs.length - 1)];
    this.failures += 1;
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref?.();
  }
}

export const codexThreadStatus = new CodexThreadStatusWatcher();
