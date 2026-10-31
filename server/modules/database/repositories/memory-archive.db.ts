import { getConnection } from '@/modules/database/connection.js';

type State = { session_id: string; revision: number; archived: number; content_revision: string; pending: number; skip_memory: number };
const initialized = new WeakSet<object>();
const mirrorInitialized = new WeakSet<object>();
function mirrors() {
  const db=getConnection();
  if (!mirrorInitialized.has(db)) {
    db.exec('CREATE TABLE IF NOT EXISTS memory_archive_mirrors (provider TEXT NOT NULL,native_id TEXT NOT NULL,remote INTEGER NOT NULL,PRIMARY KEY(provider,native_id))');
    mirrorInitialized.add(db);
  }
  return db;
}

/**
 * Project-memory's durable source outbox. SQL triggers cover explicit archives,
 * native synchronization and implicit reactivation in provider upserts alike.
 * Initial discovery establishes a baseline; it never summarizes old archives.
 */
export const memoryArchiveDb = {
  /** Initial provider discovery must finish before the first-install outbox baseline is enabled. */
  started(): boolean { return initialized.has(getConnection()); },
  /** Claude Desktop marks SSH copies; only the node holding the original reports material. */
  setMirror(provider:string,nativeId:string,remote:boolean): void {
    mirrors().prepare(`INSERT INTO memory_archive_mirrors VALUES(?,?,?) ON CONFLICT(provider,native_id)
      DO UPDATE SET remote=excluded.remote WHERE remote<>excluded.remote`).run(provider,nativeId,remote?1:0);
  },
  isMirror(provider:string,nativeId:string): boolean {
    return Boolean(mirrors().prepare('SELECT 1 FROM memory_archive_mirrors WHERE provider=? AND native_id=? AND remote=1').get(provider,nativeId));
  },
  initialize(): void {
    const db = getConnection();
    if (initialized.has(db)) return;
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS memory_archive_state (
        session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, archived INTEGER NOT NULL,
        content_revision TEXT NOT NULL DEFAULT '', pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_native_archives (
        provider TEXT NOT NULL, native_id TEXT NOT NULL, archived INTEGER NOT NULL, observed_at INTEGER NOT NULL,
        activity TEXT NOT NULL DEFAULT '', recheck INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(provider,native_id)
      );
      CREATE TABLE IF NOT EXISTS memory_archive_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO memory_archive_state (session_id,revision,archived)
        SELECT session_id,1,isArchived FROM sessions;`);
      const stateColumns=db.prepare('PRAGMA table_info(memory_archive_state)').all() as {name:string}[];
      if (!stateColumns.some(column=>column.name==='skip_memory')) {
        db.exec('ALTER TABLE memory_archive_state ADD COLUMN skip_memory INTEGER NOT NULL DEFAULT 0');
      }
      db.exec(`DROP TRIGGER IF EXISTS memory_archive_transition;
      CREATE TRIGGER memory_archive_transition AFTER UPDATE OF isArchived ON sessions
      WHEN OLD.isArchived <> NEW.isArchived BEGIN
        INSERT INTO memory_archive_state(session_id,revision,archived,pending)
          VALUES(NEW.session_id,1,NEW.isArchived,1)
          ON CONFLICT(session_id) DO UPDATE SET revision=revision+1,archived=NEW.isArchived,content_revision='',pending=1,skip_memory=0;
      END;`);
      const columns=db.prepare('PRAGMA table_info(memory_native_archives)').all() as {name:string}[];
      if (!columns.some(column=>column.name==='activity')) db.exec("ALTER TABLE memory_native_archives ADD COLUMN activity TEXT NOT NULL DEFAULT ''");
      if (!columns.some(column=>column.name==='recheck')) db.exec('ALTER TABLE memory_native_archives ADD COLUMN recheck INTEGER NOT NULL DEFAULT 0');
    })();
    initialized.add(db);
  },
  get(id: string): State | undefined {
    this.initialize();
    return getConnection().prepare('SELECT * FROM memory_archive_state WHERE session_id=?').get(id) as State | undefined;
  },
  pending(): State[] {
    this.initialize();
    return getConnection().prepare('SELECT * FROM memory_archive_state WHERE pending=1 ORDER BY revision,session_id LIMIT 20').all() as State[];
  },
  /** Providers archive and opt out atomically, before a hook/outbox reader can see this generation. */
  archiveWithoutMemory(id: string): void {
    this.initialize();
    const db=getConnection();
    db.transaction(() => {
      const session=db.prepare('SELECT isArchived FROM sessions WHERE session_id=?').get(id) as {isArchived:number}|undefined;
      if (!session) return;
      db.prepare('UPDATE sessions SET isArchived=1 WHERE session_id=?').run(id);
      // Repeating the same request is idempotent. Opting out of an already
      // archived generation advances its fence, cancelling work still in flight.
      db.prepare(`INSERT INTO memory_archive_state(session_id,revision,archived,content_revision,pending,skip_memory)
        VALUES(?,1,1,'',1,1) ON CONFLICT(session_id) DO UPDATE SET
        skip_memory=1,revision=revision+?,content_revision='',pending=1 WHERE skip_memory=0`)
        .run(id,session.isArchived ? 1:0);
    })();
  },
  captured(id: string, revision: number, digest: string): boolean {
    return getConnection().prepare('UPDATE memory_archive_state SET content_revision=? WHERE session_id=? AND revision=?')
      .run(digest,id,revision).changes === 1;
  },
  acknowledge(id: string, revision: number): void {
    getConnection().prepare('UPDATE memory_archive_state SET pending=0 WHERE session_id=? AND revision=?').run(id,revision);
  },
  rememberDigest(id:string,digest:string): void {
    const db=getConnection();
    const row=db.prepare('SELECT provider,coalesce(provider_session_id,session_id) AS native_id FROM sessions WHERE session_id=?')
      .get(id) as {provider:string;native_id:string}|undefined;
    if (row) db.prepare('INSERT OR REPLACE INTO memory_archive_settings VALUES(?,?)').run(`digest:${row.provider}:${row.native_id}`,digest);
  },
  nativeRechecks(): Array<{provider:string;native_id:string;activity:string;session_id:string}> {
    this.initialize();
    return getConnection().prepare(`SELECT n.provider,n.native_id,n.activity,s.session_id FROM memory_native_archives n
      JOIN sessions s ON s.provider=n.provider AND coalesce(s.provider_session_id,s.session_id)=n.native_id
      LEFT JOIN memory_archive_state m ON m.session_id=s.session_id
      WHERE n.recheck=1 AND n.archived=1 AND coalesce(m.skip_memory,0)=0 LIMIT 10`).all() as Array<{provider:string;native_id:string;activity:string;session_id:string}>;
  },
  /** Detect a full active→archive cycle missed while offline without treating a rename as new conversation content. */
  finishNativeCheck(provider:string,nativeId:string,activity:string,digest?:string): void {
    const db=getConnection();
    db.transaction(()=>{
      if (!db.prepare('SELECT 1 FROM memory_native_archives WHERE provider=? AND native_id=? AND activity=? AND recheck=1 AND archived=1')
        .get(provider,nativeId,activity)) return;
      // A stale scan must not manufacture a restore that clears an explicit
      // opt-out. Only an observed restore/active turn starts a new generation.
      if (db.prepare(`SELECT 1 FROM memory_archive_state m JOIN sessions s ON s.session_id=m.session_id
        WHERE s.provider=? AND coalesce(s.provider_session_id,s.session_id)=? AND m.skip_memory=1`)
        .get(provider,nativeId)) return;
      const previous=db.prepare('SELECT value FROM memory_archive_settings WHERE key=?').get(`digest:${provider}:${nativeId}`) as {value:string}|undefined;
      if (digest && previous && previous.value!==digest) {
        // Both writes and the outbox generation changes are one transaction.
        // The intermediate active state is never exposed to readers.
        const change=db.prepare('UPDATE sessions SET isArchived=? WHERE provider=? AND coalesce(provider_session_id,session_id)=?');
        change.run(0,provider,nativeId);change.run(1,provider,nativeId);
      }
      db.prepare('UPDATE memory_native_archives SET recheck=0 WHERE provider=? AND native_id=? AND activity=?').run(provider,nativeId,activity);
    })();
  },
  nativeBaselineComplete(): boolean {
    this.initialize();
    return Boolean(getConnection().prepare("SELECT 1 FROM memory_archive_settings WHERE key='codex-baseline'").get());
  },
  completeNativeBaseline(): void {
    getConnection().prepare("INSERT OR REPLACE INTO memory_archive_settings VALUES('codex-baseline','1')").run();
  },
  /** Providers call this only for an affirmative native archive state, never a missing list row. */
  observeNative(provider: string, nativeId: string, archived: boolean, baseline = false, scanStarted?: number, activity?:string, apply=true): void {
    this.initialize();
    const db=getConnection();
    db.transaction(() => {
      const previous=db.prepare('SELECT archived,observed_at,activity,recheck FROM memory_native_archives WHERE provider=? AND native_id=?')
        .get(provider,nativeId) as {archived:number;observed_at:number;activity:string;recheck:number}|undefined;
      if (previous && scanStarted!==undefined && previous.observed_at>=scanStarted) return;
      const recheck=archived && (previous?.recheck || (!baseline && previous?.archived && activity && previous.activity && previous.activity!==activity));
      db.prepare('INSERT OR REPLACE INTO memory_native_archives VALUES(?,?,?,?,?,?)')
        .run(provider,nativeId,archived?1:0,Date.now(),activity ?? previous?.activity ?? '',recheck?1:0);
      if (apply && !baseline && (!previous || Boolean(previous.archived)!==archived)) {
        db.prepare('UPDATE sessions SET isArchived=? WHERE provider=? AND coalesce(provider_session_id,session_id)=?')
          .run(archived?1:0,provider,nativeId);
      }
    })();
  },
};
