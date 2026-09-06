import { readdir } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { resolveCodexHomeDirectory } from '@/shared/utils.js';

/**
 * Used by the Codex history and resume adapters to distinguish legacy rollouts
 * from native paginated histories. Reads metadata only, never opens a thread
 * writer or changes Codex databases. Unknown future modes are returned intact
 * so callers can require the owning daemon rather than guess at their format.
 */
export async function readCodexHistoryMode(threadId: string): Promise<string | null> {
  const home = resolveCodexHomeDirectory();
  let entries: string[];
  try { entries = await readdir(home); } catch { return null; }
  const names = entries.filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
  for (const name of names) {
    let db: Database.Database | undefined;
    try {
      db = new Database(path.join(home, name), { readonly: true, fileMustExist: true });
      const columns = db.pragma('table_info(threads)') as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'history_mode')) continue;
      const row = db.prepare('SELECT history_mode FROM threads WHERE id = ?').get(threadId) as { history_mode: string } | undefined;
      if (row) return row.history_mode;
    } finally {
      db?.close();
    }
  }
  return null;
}
