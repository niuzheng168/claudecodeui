import { getConnection } from '@/modules/database/connection.js';

const RETENTION_DAYS = 30;

export type InboundMessageClaim =
  | { state: 'new' }
  | { state: 'done'; result: unknown }
  | { state: 'in_progress' }
  /** Under way for longer than any delivery takes: this process stopped during it, so whether it ran is unknown. */
  | { state: 'unconfirmed' };

const STALE_MINUTES = 5;

/**
 * Session messages the Portal delivered here, by its message ID, so a
 * delivery the Portal retries returns the first result instead of starting
 * another turn (see CODEY_INBOUND_MESSAGES_TABLE_SCHEMA_SQL).
 */
export const codeyInboundMessagesDb = {
  /** Reserves `messageId` for this delivery, or reports the earlier one. */
  claim(messageId: string, sessionId: string): InboundMessageClaim {
    const db = getConnection();
    return db.transaction((): InboundMessageClaim => {
      const row = db.prepare(`SELECT result, created_at < datetime('now', '-${STALE_MINUTES} minutes') AS stale
        FROM codey_inbound_messages WHERE message_id = ?`)
        .get(messageId) as { result: string | null; stale: number } | undefined;
      if (row) {
        if (row.result === null) return row.stale ? { state: 'unconfirmed' } : { state: 'in_progress' };
        try {
          return { state: 'done', result: JSON.parse(row.result) as unknown };
        } catch {
          return { state: 'in_progress' };
        }
      }
      db.prepare(`DELETE FROM codey_inbound_messages WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')`).run();
      db.prepare('INSERT INTO codey_inbound_messages (message_id, session_id) VALUES (?, ?)').run(messageId, sessionId);
      return { state: 'new' };
    })();
  },

  complete(messageId: string, result: unknown): void {
    getConnection().prepare('UPDATE codey_inbound_messages SET result = ? WHERE message_id = ?')
      .run(JSON.stringify(result), messageId);
  },

  /** A delivery that was refused leaves no record; the Portal reports the refusal and does not retry. */
  release(messageId: string): void {
    getConnection().prepare('DELETE FROM codey_inbound_messages WHERE message_id = ? AND result IS NULL').run(messageId);
  },
};
