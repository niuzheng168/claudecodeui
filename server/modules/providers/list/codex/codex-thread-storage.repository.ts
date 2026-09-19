import { readdir } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { AppError, readObjectRecord, resolveCodexHomeDirectory } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/index.js';

async function readThreadMetadata(threadId: string, requireHistoryMode = false): Promise<AnyRecord | null> {
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
      if (!columns.some((column) => column.name === 'id')) continue;
      if (requireHistoryMode && !columns.some((column) => column.name === 'history_mode')) continue;
      const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
      if (row) return readObjectRecord(row);
    } finally {
      db?.close();
    }
  }
  return null;
}

/**
 * Used by the Codex history and resume adapters to distinguish legacy rollouts
 * from native paginated histories. Reads metadata only, never opens a thread
 * writer or changes Codex databases. Unknown future modes are returned intact
 * so callers can require the owning daemon rather than guess at their format.
 */
export async function readCodexHistoryMode(threadId: string): Promise<string | null> {
  const row = await readThreadMetadata(threadId, true);
  return typeof row?.history_mode === 'string' ? row.history_mode : null;
}

/**
 * Used by the desktop queue runtime on every platform before enqueueing. Native queued
 * inputs inherit the owner's settings: reject incompatible explicit selections
 * instead of silently changing models, widening permissions, or modifying the
 * other client's configuration. This reads only the requested metadata row.
 */
export async function assertCodexDesktopSelection(threadId: string, options: AnyRecord): Promise<void> {
  const model = typeof options.model === 'string' && options.model ? options.model : null;
  const effort = typeof options.effort === 'string' && options.effort !== 'default' ? options.effort : null;
  const mode = options.permissionMode;
  if (!model && !effort && mode == null) return;
  const row = await readThreadMetadata(threadId);
  const incompatible = (message: string) => new AppError(message, { code: 'CODEX_DESKTOP_SETTINGS_MISMATCH', statusCode: 409 });
  if (!row) throw incompatible('Cannot verify the desktop settings. No message was queued.');
  if (model && model !== row.model) {
    throw incompatible(`This desktop-owned session uses ${row.model || 'its desktop model'}. Select the same model, or change it in Codex Desktop first. No message was queued.`);
  }
  if (effort && effort !== row.reasoning_effort) {
    throw incompatible(`This desktop-owned session uses ${row.reasoning_effort || 'its desktop reasoning effort'}. Match that setting before sending. No message was queued.`);
  }
  if (mode == null || mode === 'bypassPermissions') return; // Inheriting anything stricter cannot widen this explicit selection.
  let sandbox: AnyRecord | null = null;
  try { sandbox = readObjectRecord(JSON.parse(row.sandbox_policy)); } catch { /* Unknown policies fail closed. */ }
  const roots = sandbox?.writable_roots ?? sandbox?.writableRoots ?? [];
  const cwd = typeof options.cwd === 'string' ? path.resolve(options.cwd) : null;
  const onlyCwd = Array.isArray(roots) && roots.every(root => {
    if (typeof root !== 'string' || !cwd) return false;
    const resolved = path.resolve(root);
    // The former Windows-only queue normalized case. On Unix, distinct
    // case-sensitive roots must not pass an explicit workspace restriction.
    return process.platform === 'win32'
      ? resolved.toLowerCase() === cwd.toLowerCase()
      : resolved === cwd;
  });
  const boundedSandbox = ['workspace-write', 'workspaceWrite', 'read-only', 'readOnly'].includes(sandbox?.type)
    && sandbox?.network_access !== true && sandbox?.networkAccess !== true && onlyCwd;
  const boundedApproval = mode === 'default'
    ? row.approval_mode === 'untrusted'
    : mode === 'acceptEdits' && ['untrusted', 'on-request', 'never'].includes(row.approval_mode);
  if (!boundedSandbox || !boundedApproval) {
    throw incompatible('The desktop session does not match the selected permission restrictions. Match the desktop settings before sending; Codey has not widened permissions or queued the message.');
  }
}
