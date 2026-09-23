import { randomUUID } from 'node:crypto';

import { AppError, sliceTailPage } from '@/shared/index.js';
import type { FetchHistoryOptions, FetchHistoryResult } from '@/shared/index.js';

type Snapshot = {
  id: string;
  source: string;
  history: FetchHistoryResult;
  positions: Map<string, number>;
  bytes: number;
  usedAt: number;
};

type SnapshotRequest = Pick<FetchHistoryOptions, 'limit' | 'offset' | 'snapshotId' | 'before'> & {
  /** Includes database, app/native session IDs and project; a token is never authorization. */
  source: string;
  load: () => Promise<FetchHistoryResult>;
};

/**
 * Used by SessionsService for native histories whose JSONL is only an export.
 * One authenticated read materializes a snapshot; older pages keep reading that
 * immutable window instead of walking thousands of native items on every scroll.
 * A fresh tail request always revalidates through the provider. Evicted snapshots
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

  async function readSnapshot(source: string, load: SnapshotRequest['load']): Promise<Snapshot> {
    const existing = pending.get(source);
    if (existing) return existing;
    const request = (async () => {
      const history = await load();
      const entry: Snapshot = {
        id: randomUUID(), source, history,
        positions: new Map(history.messages.map((message, index) => [message.id, index])),
        bytes: Buffer.byteLength(JSON.stringify(history)),
        usedAt: now(),
      };
      // Never retain an unbounded allocation; an oversized snapshot still serves
      // this request, and subsequent anchor reads can reconstruct it safely.
      if (entry.bytes <= maxBytes) {
        snapshots.set(entry.id, entry);
        prune();
      }
      return entry;
    })();
    pending.set(source, request);
    try { return await request; }
    finally { if (pending.get(source) === request) pending.delete(source); }
  }

  return {
    async page({ source, limit = null, offset = 0, snapshotId, before, load }: SnapshotRequest): Promise<FetchHistoryResult> {
      prune();
      let snapshot = snapshotId ? snapshots.get(snapshotId) : undefined;
      if (snapshot && snapshot.source !== source) {
        throw new AppError('This history snapshot belongs to another session.', {
          code: 'HISTORY_SNAPSHOT_MISMATCH', statusCode: 409,
        });
      }
      if (!snapshot && snapshotId && !before) {
        throw new AppError('This history snapshot expired. Reload the conversation to obtain a fresh snapshot.', {
          code: 'HISTORY_SNAPSHOT_EXPIRED', statusCode: 409,
        });
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
      return {
        ...snapshot.history, messages: page, hasMore, offset: requestedOffset, limit,
        snapshotId: snapshot.id, ...(before ? { before } : {}),
      };
    },
  };
}

/** Used by SessionsService; entries live only in this node's process and remain bounded. */
export const sessionHistorySnapshots = createSessionHistorySnapshots();
