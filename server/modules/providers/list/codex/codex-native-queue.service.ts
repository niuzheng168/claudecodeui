import { createHash, randomUUID } from 'node:crypto';

import { AppError, readObjectRecord } from '@/shared/index.js';
import type { AnyRecord, ICodexRpcClient } from '@/shared/index.js';

type QueueObserver = {
  item(item: AnyRecord, turnId: string): void;
  started(turnId: string): void;
};

/**
 * Used by CodexSharedRuntime when the Windows desktop already owns a thread.
 * Queue RPCs operate without acquiring its writer. The original owner executes
 * the submission, including localImage inputs, with its own model/permissions.
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

  constructor(
    private readonly client: ICodexRpcClient,
    private readonly threadId: string,
    private readonly observer: QueueObserver,
    private readonly options: {
      /** Reuses the submitting browser's identity so its optimistic echo can reconcile with native history. */
      clientMessageId?: string;
      sleep?: (ms: number) => Promise<void>;
      clock?: () => number;
      timeoutMs?: number;
    } = {},
  ) {
    this.clientId = options.clientMessageId ?? randomUUID();
  }

  async run(input: AnyRecord[]): Promise<{ turn: AnyRecord | null; cancelled: boolean }> {
    try {
      const snapshot = await this.client.request('thread/read', { threadId: this.threadId, includeTurns: false });
      if (snapshot.thread?.id !== this.threadId || snapshot.thread.source !== 'vscode') {
        throw this.error('The native desktop thread identity could not be verified.', 'CODEX_DESKTOP_QUEUE_UNAVAILABLE');
      }
      const baseline = await this.turns(null, 1);
      this.baselineTurnId = baseline.data[0]?.id ?? null;
      // Probe support before submitting anything. An older CLI must fail closed.
      await this.queuePage(null);
      if (this.cancelRequested) {
        this.cancelled = true;
        return { turn: null, cancelled: true };
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
    } finally {
      this.enqueueFinished();
    }

    const clock = this.options.clock ?? Date.now;
    const deadline = clock() + (this.options.timeoutMs ?? 24 * 60 * 60_000);
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let missingSince: number | null = null;
    while (clock() < deadline) {
      if (this.cancelled) return { turn: null, cancelled: true };
      const turn = await this.findOwnTurn();
      if (turn) {
        await this.assertReaderOnly();
        if (!this.turnId) {
          this.turnId = turn.id;
          this.observer.started(turn.id);
        }
        await this.emitItems(turn.id);
        // A read-only app-server reports another process's unfinished turn as
        // "interrupted". Only its durable end timestamp proves completion.
        if (['completed', 'failed', 'interrupted'].includes(turn.status) && Number.isFinite(turn.completedAt)) {
          return { turn, cancelled: false };
        }
        missingSince = null;
      } else if (await this.findQueuedSubmission()) {
        missingSince = null;
      } else {
        // The owner may have claimed the queue before committing the new turn.
        // Allow that short transition, but do not hang forever after deletion.
        missingSince ??= clock();
        if (clock() - missingSince > 30_000) {
          throw this.error('The desktop queue no longer contains this request, but its matching turn is not available. Check Codex before retrying; no replacement turn was started.', 'CODEX_DESKTOP_QUEUE_UNCONFIRMED');
        }
      }
      await sleep(1500);
    }
    throw this.error('The desktop submission is still pending or running. It remains in Codex; check the original session before retrying.', 'CODEX_DESKTOP_QUEUE_TIMEOUT');
  }

  /** Cancel only our unclaimed queue entry; never interrupt a desktop-owned turn. */
  async cancel(): Promise<boolean> {
    this.cancelRequested = true;
    await this.enqueueSettled;
    if (!this.queuedId || this.turnId || this.cancelled) return this.cancelled;
    if (!await this.findQueuedSubmission()) return false;
    try {
      await this.client.request('thread/queue/delete', { threadId: this.threadId, queuedSubmissionId: this.queuedId });
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
      threadId: this.threadId, cursor, limit, sortDirection: 'desc', itemsView: 'summary',
    });
    if (!Array.isArray(result.data)) throw this.error('Codex returned an invalid turn page.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
    return result;
  }

  private async findOwnTurn(): Promise<AnyRecord | null> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const response = await this.turns(cursor);
      for (const turn of response.data) {
        if (typeof turn?.id !== 'string') throw this.error('Codex returned an invalid turn identity.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
        if (turn.id === this.turnId) return turn;
        if (turn.id === this.baselineTurnId) return null;
        // Some versions omit the user item in the summary view.
        const summary = Array.isArray(turn.items) ? turn.items : [];
        const user = summary.find((item: AnyRecord) => item.type === 'userMessage');
        const items = user ? summary : await this.itemPage(turn.id, null, 10);
        if (items.some((item: AnyRecord) => item.type === 'userMessage' && item.clientId === this.clientId)) return turn;
      }
      cursor = this.nextCursor(response, seen);
      if (!cursor) return null;
    }
    throw this.error('The desktop turn could not be correlated within the bounded history window. No other turn was used.', 'CODEX_DESKTOP_QUEUE_UNCONFIRMED');
  }

  private async itemPage(turnId: string, cursor: string | null, limit: number, pageResult?: AnyRecord): Promise<AnyRecord[]> {
    const response = await this.client.request('thread/items/list', {
      threadId: this.threadId, turnId, cursor, limit, sortDirection: 'asc',
    });
    if (!Array.isArray(response.data) || response.data.some((entry: AnyRecord) =>
      entry?.turnId !== turnId || !readObjectRecord(entry.item) || typeof entry.item.id !== 'string')) {
      throw this.error('Codex returned items for an unverified turn.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
    }
    if (pageResult) Object.assign(pageResult, response);
    return response.data.map((entry: AnyRecord) => entry.item);
  }

  private async emitItems(turnId: string): Promise<void> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const response: AnyRecord = {};
      const items = await this.itemPage(turnId, cursor, 100, response);
      for (const item of items) {
        if (item.type === 'userMessage') continue; // Already echoed by the Codey gateway.
        const signature = createHash('sha256').update(JSON.stringify(item)).digest('hex');
        if (this.emitted.get(item.id) === signature) continue;
        this.emitted.set(item.id, signature);
        this.observer.item(item, turnId);
      }
      cursor = this.nextCursor(response, seen);
      if (!cursor) return;
    }
    throw this.error('The native turn exceeds the bounded item window. Its persisted history remains in Codex.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
  }

  private async queuePage(cursor: string | null): Promise<AnyRecord> {
    const response = await this.client.request('thread/queue/list', { threadId: this.threadId, cursor, limit: 100 });
    if (!Array.isArray(response.data)) throw this.error('Codex returned an invalid queue page.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
    return response;
  }

  private async assertReaderOnly(): Promise<void> {
    const response = await this.client.request('thread/loaded/list', {});
    if (!Array.isArray(response.data) || response.data.length !== 0) {
      throw this.error('The queue helper unexpectedly loaded a thread. It will be closed without taking over the desktop runtime.', 'CODEX_DESKTOP_QUEUE_PROTOCOL_ERROR');
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
