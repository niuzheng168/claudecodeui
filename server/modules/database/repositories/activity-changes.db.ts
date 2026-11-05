import { getConnection } from '@/modules/database/connection.js';

export type ActivitySessionChangeKind = 'archived' | 'restored' | 'deleted';

/** The latest archive, restore or deletion of one session the Portal has not taken yet. */
export type ActivitySessionChange = {
  sessionId: string;
  provider: 'claude' | 'codex';
  change: ActivitySessionChangeKind;
  /** Grows with every change of the session, so a newer one is not acknowledged by an older report. */
  revision: number;
};

const initialized = new WeakSet<object>();

/**
 * The activity reporter's outbox of Claude and Codex sessions archived,
 * restored or deleted here, so the Codey Portal's overview stops listing a
 * session put away (docs/codey-project-overview-design.md §4.1). SQL triggers
 * catch every way it happens: the session menu, Claude Desktop's archive, a
 * running turn restoring one, a transcript gone, a project deleted. Only the
 * latest change of each session is kept, until the Portal has it.
 */
export const activityChangesDb = {
  initialize(): void {
    const db = getConnection();
    if (initialized.has(db)) return;
    // Triggers go with the sessions table when a migration rebuilds it, so they are made on every start.
    db.exec(`CREATE TABLE IF NOT EXISTS activity_session_changes (
        session_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
        change TEXT NOT NULL CHECK (change IN ('archived', 'restored', 'deleted')), revision INTEGER NOT NULL
      );
      DROP TRIGGER IF EXISTS activity_session_archive;
      CREATE TRIGGER activity_session_archive AFTER UPDATE OF isArchived ON sessions
      WHEN OLD.isArchived <> NEW.isArchived AND NEW.provider IN ('claude', 'codex') BEGIN
        INSERT INTO activity_session_changes (session_id, provider, change, revision)
          VALUES (NEW.session_id, NEW.provider, CASE WHEN NEW.isArchived THEN 'archived' ELSE 'restored' END, 1)
          ON CONFLICT (session_id) DO UPDATE SET provider = excluded.provider, change = excluded.change, revision = revision + 1;
      END;
      DROP TRIGGER IF EXISTS activity_session_delete;
      CREATE TRIGGER activity_session_delete AFTER DELETE ON sessions
      WHEN OLD.provider IN ('claude', 'codex') BEGIN
        INSERT INTO activity_session_changes (session_id, provider, change, revision)
          VALUES (OLD.session_id, OLD.provider, 'deleted', 1)
          ON CONFLICT (session_id) DO UPDATE SET provider = excluded.provider, change = 'deleted', revision = revision + 1;
      END;
      DROP TRIGGER IF EXISTS activity_session_return;
      CREATE TRIGGER activity_session_return AFTER INSERT ON sessions BEGIN
        UPDATE activity_session_changes
          SET change = CASE WHEN NEW.isArchived THEN 'archived' ELSE 'restored' END, revision = revision + 1
          WHERE session_id = NEW.session_id AND change = 'deleted';
      END;`);
    initialized.add(db);
  },

  /** Changes the Portal does not have yet, oldest first. */
  pending(limit: number): ActivitySessionChange[] {
    this.initialize();
    return getConnection().prepare(`SELECT session_id AS sessionId, provider, change, revision
      FROM activity_session_changes ORDER BY rowid LIMIT ?`).all(limit) as ActivitySessionChange[];
  },

  /** The Portal has these; a session changed again since keeps its newer change. */
  acknowledge(changes: Array<Pick<ActivitySessionChange, 'sessionId' | 'revision'>>): void {
    const db = getConnection();
    const remove = db.prepare('DELETE FROM activity_session_changes WHERE session_id = ? AND revision = ?');
    db.transaction(() => {
      for (const change of changes) remove.run(change.sessionId, change.revision);
    })();
  },
};
