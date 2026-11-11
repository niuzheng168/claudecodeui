import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { antigravityHome } from '@/modules/providers/list/antigravity/antigravity-settings.service.js';
import { readAntigravityTokenUsage } from '@/modules/providers/list/antigravity/antigravity-usage.service.js';
import { readObjectRecord, sliceTailPage } from '@/shared/index.js';
import type {
  FetchHistoryOptions, FetchHistoryResult, IProviderSessions, IProviderSessionSynchronizer,
  NormalizedMessage,
} from '@/shared/index.js';

type SessionMetadata = {
  id: string;
  projectPath: string;
  title: string;
  createdAt: string;
  model: string;
};

const SESSION_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

const directory = (id: string): string => {
  if (!SESSION_ID.test(id)) throw new Error('Invalid Antigravity conversation ID.');
  return path.join(antigravityHome(), 'sessions', id);
};

/** Runtime and history adapters share the journal beside the SDK's native state. */
export const antigravitySessionStore = {
  directory,
  transcript: (id: string) => path.join(directory(id), 'messages.jsonl'),
  async read(id: string): Promise<SessionMetadata | null> {
    try {
      const value = JSON.parse(await readFile(path.join(directory(id), 'metadata.json'), 'utf8')) as SessionMetadata;
      if (value.id !== id || !path.isAbsolute(value.projectPath)) throw new Error('Invalid Antigravity session metadata.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  async create(metadata: SessionMetadata): Promise<void> {
    const root = directory(metadata.id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, 'metadata.json'), JSON.stringify(metadata) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(this.transcript(metadata.id), '', { mode: 0o600, flag: 'wx' });
  },
  async append(id: string, message: NormalizedMessage): Promise<void> {
    await appendFile(this.transcript(id), JSON.stringify(message) + '\n', { mode: 0o600 });
  },
  async setModel(id: string, model: string): Promise<void> {
    const metadata = await this.read(id);
    if (!metadata || metadata.model === model) return;
    const target = path.join(directory(id), 'metadata.json');
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...metadata, model }) + '\n', { mode: 0o600 });
    await rename(temporary, target);
  },
  async messages(id: string): Promise<NormalizedMessage[]> {
    let content: string;
    try { content = await readFile(this.transcript(id), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return content.split('\n').filter(Boolean).flatMap(line => {
      try {
        const value = readObjectRecord(JSON.parse(line));
        return value?.provider === 'antigravity' && typeof value.id === 'string' && typeof value.kind === 'string'
          ? [value as NormalizedMessage] : [];
      } catch { return []; } // A crash can leave one partial final append.
    });
  },
};

/** Registry history facet; IDs remain stable across live updates and page reloads. */
export class AntigravitySessionsProvider implements IProviderSessions {
  async deletePersistedSession(providerSessionId: string): Promise<boolean> {
    const root = directory(providerSessionId);
    try { await stat(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    await rm(root, { recursive: true, force: true });
    return true;
  }

  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const value = readObjectRecord(raw);
    if (value?.provider !== 'antigravity' || typeof value.kind !== 'string' || typeof value.id !== 'string') return [];
    return [{ ...value, sessionId: sessionId ?? value.sessionId ?? '' } as NormalizedMessage];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const row = sessionsDb.getSessionById(sessionId);
    const nativeId = row?.provider_session_id ?? options.providerSessionId ?? sessionId;
    const journal = await antigravitySessionStore.messages(nativeId);
    const metadata = await antigravitySessionStore.read(nativeId);
    const tokenUsage = await readAntigravityTokenUsage(nativeId, antigravitySessionStore.transcript(nativeId),
      { messages: journal, model: row?.model ?? metadata?.model }).catch(() => undefined);
    const messages = journal
      .filter(message => message.kind !== 'status')
      .map(message => ({ ...message, sessionId }));
    const limit = options.limit === undefined ? 50 : options.limit;
    const offset = options.offset ?? 0;
    const { page, hasMore } = sliceTailPage(messages, limit, offset);
    return { messages: page, total: messages.length, hasMore, offset, limit, tokenUsage };
  }
}

/** Registry/watcher index Codey-owned SDK journals without touching native Google sessions. */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    let entries;
    try { entries = await readdir(path.join(antigravityHome(), 'sessions'), { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      const file = antigravitySessionStore.transcript(entry.name);
      try {
        if (since && (await stat(file)).mtime < since) continue;
        if (await this.synchronizeFile(file)) count++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return count;
  }

  async synchronizeFile(file: string): Promise<string | null> {
    if (path.basename(file) !== 'messages.jsonl') return null;
    const id = path.basename(path.dirname(file));
    if (!SESSION_ID.test(id) || path.resolve(file) !== antigravitySessionStore.transcript(id)) return null;
    const metadata = await antigravitySessionStore.read(id);
    const info = await stat(file);
    if (!metadata || info.size === 0) return null;
    return sessionsDb.createSession(id, 'antigravity', metadata.projectPath, metadata.title,
      metadata.createdAt, info.mtime.toISOString(), file);
  }
}
