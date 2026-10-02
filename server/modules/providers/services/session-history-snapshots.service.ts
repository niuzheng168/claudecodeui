import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AppError, sliceTailPage } from '@/shared/index.js';
import type { FetchHistoryOptions, FetchHistoryResult, NativeTranscriptPosition, NormalizedMessage } from '@/shared/index.js';

type Snapshot = {
  id: string;
  source: string;
  history: FetchHistoryResult;
  positions: Map<string, number>;
  bytes: number;
  usedAt: number;
};

type SnapshotRequest = Pick<FetchHistoryOptions, 'limit' | 'offset' | 'snapshotId' | 'before' | 'after' | 'syncCursor'> & {
  /** Includes database, app/native session IDs and project; a token is never authorization. */
  source: string;
  load: () => Promise<FetchHistoryResult>;
  /** Native providers can extend a known snapshot without rereading its older items. */
  loadAfter?: (anchor: Pick<NormalizedMessage, 'id' | 'nativePosition'>, limit: number) => Promise<FetchHistoryResult | null>;
};

/**
 * Used by SessionsService for native histories and stat-validated JSONL histories.
 * One authenticated read materializes a snapshot; older pages keep reading that
 * immutable window instead of walking thousands of native items on every scroll.
 * A forward request revalidates and extends the confirmed boundary. Evicted snapshots
 * recover by a persisted row anchor, never by guessing a shifted tail offset.
 */
export function createSessionHistorySnapshots({
  maxBytes = 128 * 1024 * 1024,
  maxEntries = 16,
  maxAgeMs = 30 * 60_000,
  now = Date.now,
} = {}) {
  const snapshots = new Map<string, Snapshot>();
  const pending = new Map<string, Promise<Snapshot>>();
  // Not an authorization credential: session access/mapping is resolved first.
  // Signing keeps client-supplied positions/counts from being trusted. No
  // snapshot retention is required; a node process restart invalidates tokens.
  const cursorKey = randomBytes(32);
  const sourceHash = (source: string) => createHash('sha256').update(source).digest('hex');
  type Resume = { source: string; after: string; position: NativeTranscriptPosition; prefixCount: number; expires: number };
  const signature = (body: string) => createHmac('sha256', cursorKey).update(body).digest();

  function readCursor(token: string, source: string, after: string): Resume {
    try {
      const [body, mac, extra] = token.split('.');
      const received = Buffer.from(mac ?? '', 'base64url');
      if (extra || received.length !== 32 || !timingSafeEqual(signature(body), received)) throw new Error('signature');
      const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as Resume;
      if (value.expires < now()) throw new Error('expired');
      if (value.source !== sourceHash(source) || value.after !== after) {
        throw new AppError('The resume cursor does not match this session and row.', {
          code: 'HISTORY_SNAPSHOT_MISMATCH', statusCode: 409,
        });
      }
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('The resume cursor expired. Obtain a fresh history checkpoint.', {
        code: 'HISTORY_SNAPSHOT_EXPIRED', statusCode: 409,
      });
    }
  }

  function withCursor(result: FetchHistoryResult, source: string, prefixCount: number): FetchHistoryResult {
    let index = result.messages.length - 1;
    const position = result.messages[index]?.nativePosition;
    if (!position?.itemId || position.cursor === undefined) return result;
    // A native item can project to several display rows. Replay from its first
    // row so a refresh can repair the whole final item rather than duplicate it.
    while (index > 0) {
      const before = result.messages[index - 1].nativePosition;
      if (before?.turnId !== position.turnId || before.itemIndex !== position.itemIndex) break;
      index--;
    }
    const body = Buffer.from(JSON.stringify({
      source: sourceHash(source), after: result.messages[index].id, position,
      prefixCount: prefixCount + index, expires: now() + 7 * 24 * 60 * 60_000,
    } satisfies Resume)).toString('base64url');
    return { ...result, syncCursor: `${body}.${signature(body).toString('base64url')}` };
  }

  function prune(): void {
    const time = now();
    for (const [id, entry] of snapshots) {
      if (time - entry.usedAt >= maxAgeMs) snapshots.delete(id);
    }
    let bytes = [...snapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [id, entry] of snapshots) {
      if (snapshots.size <= maxEntries && bytes <= maxBytes) break;
      snapshots.delete(id);
      bytes -= entry.bytes;
    }
  }

  function retain(source: string, history: FetchHistoryResult): Snapshot {
    const entry: Snapshot = {
      id: randomUUID(), source, history,
      positions: new Map(history.messages.map((message, index) => [message.id, index])),
      bytes: Buffer.byteLength(JSON.stringify(history)),
      usedAt: now(),
    };
    if (entry.bytes <= maxBytes) {
      snapshots.set(entry.id, entry);
      prune();
    }
    return entry;
  }

  async function readSnapshot(source: string, load: SnapshotRequest['load']): Promise<Snapshot> {
    const existing = pending.get(source);
    if (existing) return existing;
    const request = (async () => {
      const history = await load();
      // Stat-validated JSONL caches return the same immutable object. Paging a
      // fresh tail must not serialize/index that entire transcript again.
      for (const entry of snapshots.values()) {
        if (entry.source === source && entry.history === history) {
          entry.usedAt = now();
          snapshots.delete(entry.id);
          snapshots.set(entry.id, entry);
          return entry;
        }
      }
      // Never retain an unbounded allocation; an oversized snapshot still serves
      // this request, and subsequent anchor reads can reconstruct it safely.
      return retain(source, history);
    })();
    pending.set(source, request);
    try { return await request; }
    finally { if (pending.get(source) === request) pending.delete(source); }
  }

  return {
    async page({ source, limit = null, offset = 0, snapshotId, before, after, syncCursor, load, loadAfter }: SnapshotRequest): Promise<FetchHistoryResult> {
      prune();
      let snapshot = snapshotId ? snapshots.get(snapshotId) : undefined;
      if (snapshot && snapshot.source !== source) {
        throw new AppError('This history snapshot belongs to another session.', {
          code: 'HISTORY_SNAPSHOT_MISMATCH', statusCode: 409,
        });
      }
      if (after) {
        const pageSize = Math.max(2, Math.min(100, limit ?? 20));
        if (!snapshot && syncCursor && loadAfter) {
          const checkpoint = readCursor(syncCursor, source, after);
          const delta = await loadAfter({ id: after, nativePosition: checkpoint.position }, pageSize);
          if (!delta || delta.messages[0]?.id !== after || typeof delta.hasNewer !== 'boolean') {
            throw new AppError('The native history boundary changed. Obtain a fresh history checkpoint.', {
              code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
            });
          }
          return withCursor({
            ...delta, after, total: checkpoint.prefixCount + delta.messages.length,
            hasMore: checkpoint.prefixCount > 0, offset: 0, limit: pageSize,
          }, source, checkpoint.prefixCount);
        }
        const position = snapshot?.positions.get(after);
        const delta = snapshot && position !== undefined && loadAfter
          ? await loadAfter(snapshot.history.messages[position], pageSize) : null;
        if (delta && snapshot && position !== undefined) {
          if (delta.messages[0]?.id !== after) {
            throw new AppError('The newer-message anchor changed. Reload the conversation.', {
              code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
            });
          }
          const oldSuffix = snapshot.history.messages.slice(position);
          const unchanged = !snapshot.history.hasNewer && !delta.hasNewer && oldSuffix.length === delta.messages.length
            && oldSuffix.every((message, index) => JSON.stringify(message) === JSON.stringify(delta.messages[index]));
          const messages = unchanged ? snapshot.history.messages
            : [...snapshot.history.messages.slice(0, position), ...delta.messages];
          const updated = unchanged ? snapshot : retain(source, { ...delta, messages, total: messages.length });
          updated.usedAt = now();
          if (unchanged) {
            snapshots.delete(updated.id);
            snapshots.set(updated.id, updated);
          }
          return withCursor({
            ...delta, total: messages.length, hasMore: position > 0,
            snapshotId: updated.id, after, offset: 0, limit: pageSize,
          }, source, position);
        }
        // An older pinned snapshot must not answer a *fresh* tail read. JSONL
        // providers revalidate their file cache; evicted native handles rebuild.
        snapshot = await readSnapshot(source, load);
        const start = snapshot.positions.get(after);
        if (start === undefined) {
          throw new AppError('The newer-message anchor no longer exists. Reload the conversation after its history was edited.', {
            code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
          });
        }
        const end = Math.min(snapshot.history.messages.length, start + pageSize);
        return withCursor({
          ...snapshot.history, messages: snapshot.history.messages.slice(start, end),
          snapshotId: snapshot.id, after, hasMore: start > 0,
          hasNewer: end < snapshot.history.messages.length,
          offset: snapshot.history.messages.length - end, limit: pageSize,
        }, source, start);
      }
      if (!snapshot && snapshotId && !before) {
        throw new AppError('This history snapshot expired. Reload the conversation to obtain a fresh snapshot.', {
          code: 'HISTORY_SNAPSHOT_EXPIRED', statusCode: 409,
        });
      }
      if (snapshot?.history.hasNewer && limit === null && !before) {
        // A paused catch-up snapshot is a confirmed prefix, not all history.
        // Explicit "Load all" must not report that prefix as complete.
        snapshot = await readSnapshot(source, load);
      }
      snapshot ??= await readSnapshot(source, load);
      snapshot.usedAt = now();
      if (snapshots.has(snapshot.id)) {
        snapshots.delete(snapshot.id);
        snapshots.set(snapshot.id, snapshot);
      }
      let requestedOffset = Math.max(0, offset);
      if (before) {
        const position = snapshot.positions.get(before);
        if (position === undefined) {
          throw new AppError('The older-message anchor no longer exists. Reload the conversation after its history was edited.', {
            code: 'HISTORY_ANCHOR_NOT_FOUND', statusCode: 409,
          });
        }
        requestedOffset = snapshot.history.messages.length - position;
      }
      const { page, hasMore } = sliceTailPage(snapshot.history.messages, limit, requestedOffset);
      return withCursor({
        ...snapshot.history, messages: page, hasMore, offset: requestedOffset, limit,
        snapshotId: snapshot.id, ...(before ? { before } : {}),
      }, source, Math.max(0, snapshot.history.messages.length - requestedOffset - page.length));
    },
  };
}

/** Used by SessionsService; entries live only in this node's process and remain bounded. */
export const sessionHistorySnapshots = createSessionHistorySnapshots();
