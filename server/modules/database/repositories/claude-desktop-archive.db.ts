import { getConnection } from '@/modules/database/connection.js';

type ClaudeDesktopArchiveRow = {
  provider_session_id: string;
  archived: number;
  pending: number;
  desktop_activity_at: number | null;
};

/** A change Claude Desktop made that still has to reach the machine its session runs on. */
export type PendingClaudeDesktopArchive = {
  providerSessionId: string;
  archived: boolean;
  /** Desktop's own last activity in the session, ms since the epoch. */
  desktopActivityAt: number | null;
};

/**
 * Claude Desktop's archive state per Claude Code session, as this computer
 * last saw it (see CLAUDE_DESKTOP_ARCHIVE_TABLE_SCHEMA_SQL). Used by the Claude
 * Desktop archive sync to tell a change from a state it already carried over.
 */
export const claudeDesktopArchiveDb = {
  /** What was last seen for the session, or null for one never seen. */
  get(providerSessionId: string): { archived: boolean; pending: boolean } | null {
    const row = getConnection()
      .prepare('SELECT archived, pending FROM claude_desktop_archive WHERE provider_session_id = ?')
      .get(providerSessionId) as Pick<ClaudeDesktopArchiveRow, 'archived' | 'pending'> | undefined;
    return row ? { archived: Boolean(row.archived), pending: Boolean(row.pending) } : null;
  },

  /** Records the state Desktop has now; `pending` marks a change still to reach another machine. */
  set(change: PendingClaudeDesktopArchive, pending: boolean): void {
    getConnection().prepare(
      `INSERT INTO claude_desktop_archive (provider_session_id, archived, pending, desktop_activity_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider_session_id) DO UPDATE SET
         archived = excluded.archived,
         pending = excluded.pending,
         desktop_activity_at = excluded.desktop_activity_at,
         updated_at = excluded.updated_at`,
    ).run(change.providerSessionId, change.archived ? 1 : 0, pending ? 1 : 0, change.desktopActivityAt);
  },

  /** The changes still to reach the machine their session runs on, oldest first. */
  listPending(): PendingClaudeDesktopArchive[] {
    const rows = getConnection()
      .prepare(`SELECT provider_session_id, archived, pending, desktop_activity_at FROM claude_desktop_archive
        WHERE pending = 1 ORDER BY updated_at, provider_session_id`)
      .all() as ClaudeDesktopArchiveRow[];
    return rows.map((row) => ({
      providerSessionId: row.provider_session_id,
      archived: Boolean(row.archived),
      desktopActivityAt: row.desktop_activity_at,
    }));
  },

  /**
   * Clears `pending` once the change has been passed on, unless Desktop
   * changed the session again meanwhile and that newer state still has to go.
   */
  clearPending(providerSessionId: string, archived: boolean): void {
    getConnection()
      .prepare('UPDATE claude_desktop_archive SET pending = 0 WHERE provider_session_id = ? AND archived = ?')
      .run(providerSessionId, archived ? 1 : 0);
  },
};
