import { isDeepStrictEqual } from 'node:util';

import { getConnection } from '@/modules/database/connection.js';
import type { QueuedMessageOperation, QueuedSessionMessageRecord } from '@/shared/index.js';

/**
 * One chat scope's unsent state: the text still in the composer, plus the
 * FIFO queued behind an in-flight turn. Both are optional; legacy single
 * receipts remain readable alongside the new list-backed representation.
 */
export type SessionDraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  updatedAt: string;
};

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  updated_at: string;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
};

/** A queued message that no longer parses is treated as absent, not fatal. */
function parseQueuedMessage(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessage: parseQueuedMessage(row.queued_message),
    updatedAt: row.updated_at,
  };
}

function queueEntries(raw: string | null): unknown[] {
  const value = parseQueuedMessage(raw);
  return Array.isArray(value) ? value : value ? [value] : [];
}

function receiptKey(value: unknown): string {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : JSON.stringify(value);
}

function queuedRecord(row: QueuedMessageRow, index: number): QueuedSessionMessageRecord | null {
  const entries = queueEntries(row.queued_message);
  if (index < 0 || index >= entries.length) return null;
  return {
    userId: row.user_id, sessionId: row.draft_scope, queuedMessage: entries[index],
    claimToken: JSON.stringify(entries[index]),
    ...(Array.isArray(parseQueuedMessage(row.queued_message))
      ? { queueIndex: index, queuePredecessors: entries.slice(0, index).map(receiptKey) } : {}),
  };
}

function sameMessage(left: unknown, right: unknown): boolean {
  const normalized = (value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return {
      id: record.id ?? null, content: record.content, options: record.options ?? {},
      attachments: record.attachments ?? record.images ?? [], steerHold: record.steerHold ?? null,
    };
  };
  return isDeepStrictEqual(normalized(left), normalized(right));
}

/** User drafts, scheduled delivery and WebSocket steering share these atomic per-receipt operations. */
export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, updated_at
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /** Lists persisted queued turns whose scopes are real chat sessions. */
  listQueuedMessages(): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL`
      )
      .all() as QueuedMessageRow[];

    // Only the head of each session may start a new turn. Steering can select
    // any receipt, but automatic dispatch must never skip a held head.
    return rows.map(row => queuedRecord(row, 0)).filter((row): row is QueuedSessionMessageRecord => row !== null);
  },

  /** WebSocket/user queued steering reads one authenticated owner's exact compare-and-set receipt. */
  getQueuedMessage(userId: number, sessionId: string, messageId?: string | null): QueuedSessionMessageRecord | null {
    const row = getConnection().prepare(
      'SELECT user_id, draft_scope, queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ? AND queued_message IS NOT NULL',
    ).get(userId, sessionId) as QueuedMessageRow | undefined;
    if (!row) return null;
    const index = messageId ? queueEntries(row.queued_message).findIndex(value =>
      (value as { id?: unknown } | null)?.id === messageId) : 0;
    return queuedRecord(row, index);
  },

  /** Atomically removes a queued turn only if it has not been edited since listing. */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(candidate.userId, candidate.sessionId) as { queued_message: string | null } | undefined;
      if (!row) return false;
      const entries = queueEntries(row.queued_message);
      const index = entries.findIndex(value => JSON.stringify(value) === candidate.claimToken);
      if (index < 0) return false;
      entries.splice(index, 1);
      const result = db
        .prepare(
          `UPDATE session_drafts
           SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
        )
        .run(entries.length ? JSON.stringify(entries) : null, candidate.userId, candidate.sessionId, row.queued_message);
      return result.changes > 0;
    })();
  },

  /** Restores a refused claim without replacing a newer queue, even if an empty draft row was cleaned up. */
  restoreQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    if (candidate.queueIndex !== undefined) {
      const db = getConnection();
      return db.transaction(() => {
        const row = db.prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
          .get(candidate.userId, candidate.sessionId) as { queued_message: string | null } | undefined;
        const entries = queueEntries(row?.queued_message ?? null);
        const message = JSON.parse(candidate.claimToken) as { id?: unknown };
        if (entries.some(value => (value as { id?: unknown })?.id === message.id)) return false;
        const predecessors = new Set(candidate.queuePredecessors ?? []);
        const position = candidate.queuePredecessors
          ? entries.reduce<number>((last, value, index) => predecessors.has(receiptKey(value)) ? index + 1 : last, 0)
          : Math.min(candidate.queueIndex!, entries.length);
        entries.splice(position, 0, message);
        db.prepare(
          `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
           VALUES (?, ?, '', ?, CURRENT_TIMESTAMP)
           ON CONFLICT(user_id, draft_scope) DO UPDATE SET
             queued_message = excluded.queued_message, updated_at = CURRENT_TIMESTAMP`,
        ).run(candidate.userId, candidate.sessionId, JSON.stringify(entries));
        return true;
      })();
    }
    const result = getConnection()
      .prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, '', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           queued_message = excluded.queued_message, updated_at = CURRENT_TIMESTAMP
         WHERE session_drafts.queued_message IS NULL`
      )
      .run(candidate.userId, candidate.sessionId, candidate.claimToken);
    return result.changes > 0;
  },

  /** Removes the placeholder row left after its last queued turn is claimed. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's draft, or deletes the row when nothing is left to keep.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into.
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: { text: string; queuedMessage?: unknown | null; queueOperations?: QueuedMessageOperation[] }
  ): void {
    const db = getConnection();

    if (draft.queueOperations) {
      db.transaction(() => {
        const row = db.prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
          .get(userId, scope) as { queued_message: string | null } | undefined;
        let entries = queueEntries(row?.queued_message ?? null);
        for (const operation of draft.queueOperations!) {
          if (operation.kind === 'append') {
            if (!entries.some(value => (value as { id?: unknown })?.id === operation.message.id)) entries.push(operation.message);
          } else {
            entries = entries.filter(value => !sameMessage(value, operation.message));
          }
        }
        sessionDraftsDb.saveDraft(userId, scope, { text: draft.text, queuedMessage: entries.length ? entries : null });
      })();
      return;
    }

    // Autosaving textarea text must not recreate a claimed queue or erase a
    // queued message submitted from another device.
    if (!Object.hasOwn(draft, 'queuedMessage')) {
      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           draft_text = excluded.draft_text, updated_at = CURRENT_TIMESTAMP`,
      ).run(userId, scope, draft.text);
      sessionDraftsDb.deleteEmptyDraft(userId, scope);
      return;
    }

    if (!draft.text && draft.queuedMessage === null) {
      db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .run(userId, scope);
      return;
    }

    db.prepare(
      `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, draft_scope) DO UPDATE SET
         draft_text = excluded.draft_text,
         queued_message = excluded.queued_message,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      scope,
      draft.text,
      draft.queuedMessage === null ? null : JSON.stringify(draft.queuedMessage)
    );
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .run(userId, scope);
  },
};
