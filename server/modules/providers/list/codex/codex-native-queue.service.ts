import { createHash, randomUUID } from 'node:crypto';

import { AppError, readObjectRecord } from '@/shared/index.js';
import type { AnyRecord, ICodexDesktopThreadOwner, ICodexRpcClient } from '@/shared/index.js';

type QueueObserver = {
  item(item: AnyRecord, turnId: string): void;
  started(turnId: string): void;
};

/**
 * Used by CodexSharedRuntime when another desktop process already owns a thread,
 * regardless of operating system.
 * A discovered desktop peer receives explicit input at the actual owner;
 * native queue RPCs remain a compatibility path when no peer is available.
 * Neither path acquires its writer. The original owner executes the input,
 * including localImage inputs, with its own model/permissions.
 * Correlate persisted output by the native user-message clientId, never by text,
 * the most recent turn, or somebody else's completion notification.
 */
export class CodexNativeQueueRun {
  private readonly clientId: string;
  private queuedId: string | null = null;
  private turnId: string | null = null;
  private cancelled = false;
  private cancelRequested = false;
  private enqueueFinished!: () => void;
  private readonly enqueueSettled = new Promise<void>(resolve => { this.enqueueFinished = resolve; });
  private readonly emitted = new Map<string, string>();
  private baselineTurnId: string | null = null;
  private latestObservedTurn: AnyRecord | null = null;

  constructor(
    private readonly client: ICodexRpcClient,
    private readonly threadId: string,
    private readonly observer: QueueObserver,
    private readonly options: {
      /** Reuses the submitting browser's identity so its optimistic echo can reconcile with native history. */
      clientMessageId?: string;
      /** A verified peer can explicitly continue a desktop whose automatic queue was paused. */
      owner?: ICodexDesktopThreadOwner | null;
      sleep?: (ms: number) => Promise<void>;
      clock?: () => number;
      timeoutMs?: number;
      /** Bound idle, unstarted delivery separately from a legitimately long-running model turn. */
      startupTimeoutMs?: number;
    } = {},
  ) {
    this.clientId = options.clientMessageId ?? randomUUID();
  }

  async run(input: AnyRecord[]): Promise<{ turn: AnyRecord | null; cancelled: boolean }> {
    try {
      const snapshot = await this.client.request('thread/read', { threadId: this.threadId, includeTurns: false });
      if (snapshot.thread?.id !== this.threadId || (!this.options.owner && snapshot.thread.source !== 'vscode')) {
        throw this.error('The native desktop thread identity could not be verified.', 'CODEX_DESKTOP_QUEUE_UNAVAILABLE');
      }
      const baseline = await this.turns(null, 1);
      this.baselineTurnId = baseline.data[0]?.id ?? null;
      this.latestObservedTurn = baseline.data[0] ?? null;
      // Probe support before submitting anything. An older CLI must fail closed.
      const queued = await this.queuePage(null);
      await this.assertReaderOnly();
      if (this.cancelRequested) {
        this.cancelled = true;
        return { turn: null, cancelled: true };
      }
      if (this.options.owner && !this.activeTurn(this.latestObservedTurn)) {
        await this.startThroughOwner(input, queued);
        await this.assertReaderOnly();
      } else {
        if (this.pausedTurn(this.latestObservedTurn)) {
          throw this.error('The desktop stopped its previous turn and its native queue is paused. Its owner connection is unavailable; no new message was queued. Reconnect the owning desktop before retrying.',
            'CODEX_DESKTOP_QUEUE_PAUSED');
        }
        let added: AnyRecord;
        try {
          added = await this.client.request('thread/queue/add', {
            threadId: this.threadId, clientUserMessageId: this.clientId, input,
          });
        } catch {
          throw this.error('Codex did not acknowledge the desktop queue request. It may already be queued; check the original session before retrying. No prompt was resubmitted.', 'CODEX_DESKTOP_QUEUE_UNCONFIRMED');
        }
        const entry = readObjectRecord(added.queuedSubmission);
        if (!entry || typeof entry.id !== 'string' || !entry.id || entry.clientUserMessageId !== this.clientId) {
          throw this.error('Codex did not confirm the queued submission. Check the desktop queue before retrying; the prompt was not resubmitted.', 'CODEX_DESKTOP_QUEUE_UNCONFIRMED');
        }
        this.queuedId = entry.id;
        await this.assertReaderOnly();
      }
    } finally {
      this.enqueueFinished();
    }

    const clock = this.options.clock ?? Date.now;
    const deadline = clock() + (this.options.timeoutMs ?? 24 * 60 * 60_000);
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let missingSince: number | null = null;
    let idleSince: number | null = null;
    while (clock() < deadline) {
      if (this.cancelled) return { turn: null, cancelled: true };
      const turn = await this.findOwnTurn();
      if (turn) {
        await this.assertReaderOnly();
        if (!this.turnId) {
          this.turnId = turn.id;
          this.observer.started(turn.id);
        }
        this.emitItems(turn);
        // A read-only app-server reports another process's unfinished turn as
        // "interrupted". Only its durable end timestamp proves completion.
        if (['completed', 'failed', 'interrupted'].includes(turn.status) && Number.isFinite(turn.completedAt)) {
          return { turn, cancelled: false };
        }
        missingSince = null;
      } else if (this.queuedId && await this.findQueuedSubmission()) {
        missingSince = null;
        if (this.pausedTurn(this.latestObservedTurn)) {
          throw this.error('The desktop stopped while this input was queued. The pending input is still in its paused queue; it was not restarted or replayed.',
            'CODEX_DESKTOP_QUEUE_PAUSED');
        }
        if (this.activeTurn(this.latestObservedTurn)) idleSince = null;
        else idleSince ??= clock();
        if (idleSince !== null && clock() - idleSince >= (this.options.startupTimeoutMs ?? 30_000)) {
          throw this.error('The desktop has not started this queued input. It remains in the original session; check its paused queue before retrying. No replacement prompt was sent.',
            'CODEX_DESKTOP_QUEUE_NOT_STARTED');
        }
      } else {
        // The owner may have claimed the queue before committing the new turn.
        // Allow that short transition, but do not hang forever after deletion.
        missingSince ??= clock();
        if (clock() - missingSince > 30_000) {
          if (!this.queuedId) {
            throw this.error('The desktop owner acknowledged this input, but its matching turn is not available yet. Check the original session before retrying; the prompt was not queued or resubmitted.',
              'CODEX_DESKTOP_SUBMISSION_UNCONFIRMED');
          }
          throw this.error('The desktop queue no longer contains this request, but its matching turn is not available. Check Codex before retrying; no replacement turn was started.', 'CODEX_DESKTOP_QUEUE_UNCONFIRMED');
        }
      }
      await sleep(1500);
    }
    throw this.error('The desktop submission is still pending or running. It remains in Codex; check the original session before retrying.', 'CODEX_DESKTOP_QUEUE_TIMEOUT');
  }

  private async startThroughOwner(input: AnyRecord[], queued: AnyRecord): Promise<void> {
    if (queued.data.length) {
      // turn/start does not deduplicate an already queued client ID. Native
      // queue removal + peer submission is not atomic; never replay, delete,
      // or leapfrog a durable pending input just to make a new send succeed.
      throw this.error('The desktop already has pending input ahead of this message. Continue or cancel that input first; no new turn was started and the queue order was not changed.',
        'CODEX_DESKTOP_QUEUE_PENDING');
    }
    if (this.cancelRequested) {
      this.cancelled = true;
      return;
    }
    // The owner receives the original user-message identity. A lost IPC reply
    // is not permission to put the input back in the queue or retry elsewhere.
    await this.options.owner!.startTurn(input, this.clientId);
  }

  private pausedTurn(turn: AnyRecord | null): boolean {
    return Boolean(turn && ['failed', 'interrupted'].includes(turn.status) && Number.isFinite(turn.completedAt));
  }

  private activeTurn(turn: AnyRecord | null): boolean {
    return Boolean(turn && !Number.isFinite(turn.completedAt) && !['completed', 'failed'].includes(turn.status));
  }

  /** Cancel only our unclaimed queue entry; never interrupt a desktop-owned turn. */
  async cancel(): Promise<boolean> {
    this.cancelRequested = true;
    await this.enqueueSettled;
    if (!this.queuedId || this.turnId || this.cancelled) return this.cancelled;
    if (!await this.findQueuedSubmission()) return false;
    try {
      const result = await this.client.request('thread/queue/delete', { threadId: this.threadId, queuedSubmissionId: this.queuedId });
      if (result.deleted !== true) return false;
      this.cancelled = true;
      return true;
    } catch {
      // The owner may have claimed it between the read and delete. A refused
      // delete is not permission to interrupt the owner's current turn.
      return false;
    }
  }

  private async turns(cursor: string | null, limit = 20): Promise<AnyRecord> {
    const result = await this.client.request('thread/turns/list', {
      threadId: this.threadId, cursor, limit, sortDirection: 'desc', itemsView: 'full',
    });
    // Full turn pages work for both legacy and paginated histories. In
    // particular, legacy owners may not implement thread/items/list at all.
    // Verify this read capability before enqueueing, not after sending input.
    if (!Array.isArray(result.data) || result.data.some((turn: AnyRecord) =>
      typeof turn?.id !== 'string' || !turn.id || !Array.isArray(turn.items)
      || (turn.itemsView != null && turn.itemsView !== 'full'))) {
      throw this.error('Codex returned an incomplete native turn page.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
    }
    return result;
  }

  private async findOwnTurn(): Promise<AnyRecord | null> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const response = await this.turns(cursor);
      if (page === 0) this.latestObservedTurn = response.data[0] ?? null;
      for (const turn of response.data) {
        if (typeof turn?.id !== 'string') throw this.error('Codex returned an invalid turn identity.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
        if (turn.id === this.turnId) return turn;
        if (turn.id === this.baselineTurnId) return null;
        if (turn.items.some((item: AnyRecord) => item.type === 'userMessage' && item.clientId === this.clientId)) return turn;
      }
      cursor = this.nextCursor(response, seen);
      if (!cursor) return null;
    }
    throw this.error('The desktop turn could not be correlated within the bounded history window. No other turn was used.', 'CODEX_DESKTOP_QUEUE_UNCONFIRMED');
  }

  private emitItems(turn: AnyRecord): void {
    for (const item of turn.items) {
      if (!readObjectRecord(item) || typeof item.id !== 'string' || !item.id) {
        throw this.error('Codex returned an invalid native item.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
      }
      if (item.type === 'userMessage') continue; // Already echoed by the Codey gateway.
      const signature = createHash('sha256').update(JSON.stringify(item)).digest('hex');
      if (this.emitted.get(item.id) === signature) continue;
      this.emitted.set(item.id, signature);
      this.observer.item(item, turn.id);
    }
  }

  private async queuePage(cursor: string | null): Promise<AnyRecord> {
    const response = await this.client.request('thread/queue/list', { threadId: this.threadId, cursor, limit: 100 });
    if (!Array.isArray(response.data)) throw this.error('Codex returned an invalid queue page.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
    return response;
  }

  private async assertReaderOnly(): Promise<void> {
    const response = await this.client.request('thread/loaded/list', {});
    // A shared daemon may legitimately host unrelated threads. Our private
    // child must load nothing; a shared connection must not own this target.
    if (!Array.isArray(response.data) || (this.client.ownsProcess
      ? response.data.length !== 0 : response.data.includes(this.threadId))) {
      throw this.error('The queue helper unexpectedly loaded the target thread. Its connection will be closed without taking over the desktop runtime.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
    }
  }

  private async findQueuedSubmission(): Promise<boolean> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const response = await this.queuePage(cursor);
      if (response.data.some((item: AnyRecord) => item.id === this.queuedId && item.clientUserMessageId === this.clientId)) return true;
      cursor = this.nextCursor(response, seen);
      if (!cursor) return false;
    }
    throw this.error('The native queue exceeds the bounded lookup window.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
  }

  private nextCursor(response: AnyRecord, seen: Set<string>): string | null {
    const cursor = response.nextCursor;
    if (cursor == null) return null;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) {
      throw this.error('Codex returned an invalid pagination cursor.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
    }
    seen.add(cursor);
    return cursor;
  }

  private error(message: string, code: string): AppError {
    return new AppError(message, { code, statusCode: 409 });
  }
}
