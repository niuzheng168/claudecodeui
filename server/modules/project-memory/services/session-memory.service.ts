import { pathToFileURL } from 'node:url';

import { sessionsDb } from '@/modules/database/index.js';

type CacheAdapter = {
  snapshot(): Promise<{accountId?: string; nodeId?: string}>;
  versions(): Promise<Record<string, number>>;
  refresh(value: unknown): Promise<void>;
  launch(project: string, cwd: string, provider: string): Promise<string | null>;
  cancelLaunch(id: string): Promise<void>;
};
type PortalClient = (method: string, path: string, options: {body?: unknown}) => Promise<unknown>;
type BriefResponse = {
  sessions: Array<{sessionId: string; projectId: string | null; updatedAt: number}>;
};
let cache: CacheAdapter | undefined;
let request: PortalClient | undefined;
let refreshing = false;

/** Project-memory runtime loads the installed node's shared, credential-free cache implementation. */
export async function initializeSessionMemory(modulePath: string): Promise<string | undefined> {
  const module = await import(pathToFileURL(modulePath).href) as {
    memoryCache?: CacheAdapter; memoryCacheModule?: string; portalRequest?: PortalClient;
  };
  cache = module.memoryCache;
  request = module.portalRequest;
  return cache && request ? module.memoryCacheModule : undefined;
}

/** Runtime refreshes routing and changed briefs; failed/offline requests leave the last complete cache intact. */
export async function refreshSessionMemory(): Promise<void> {
  if (!cache || !request || refreshing) return;
  refreshing = true;
  try {
    const identity = await request('GET', '/api/v1/me', {}) as {user: {id: string}; node: {id: string}};
    const previous = await cache.snapshot();
    const sameOwner = previous.accountId === identity.user.id && previous.nodeId === identity.node.id;
    // A re-enrolled node must not keep showing the previous account's memory
    // when the new account's main is offline or has not yet been upgraded.
    if (previous.accountId && !sameOwner) {
      await cache.refresh({accountId: identity.user.id, nodeId: identity.node.id, projects: [], briefs: [], sessions: []});
    }
    const versions = sameOwner ? await cache.versions() : {};
    const response = await request('POST', '/api/v1/memory/briefs', {body: {versions}}) as BriefResponse;
    // Workbench often knows the stable app id, whereas native hooks/MCP name the
    // provider id. Keep both aliases so a manual move overrides either entry.
    const sessions = [...response.sessions].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).flatMap(session => {
      const row = sessionsDb.getSessionById(session.sessionId);
      return row?.provider_session_id && row.provider_session_id !== session.sessionId
        ? [session, {...session, sessionId: row.provider_session_id}] : [session];
    });
    await cache.refresh({...response, sessions});
  } finally { refreshing = false; }
}

/** Websocket dispatch records explicit Workbench placement immediately before a new native launch. */
export async function prepareMemoryLaunch(project: unknown, cwd: unknown, provider: string): Promise<string | null> {
  if (!cache || typeof project !== 'string' || typeof cwd !== 'string') return null;
  try { return await cache.launch(project, cwd, provider); }
  catch { return null; } // Memory must not prevent a chat from starting.
}

/** Websocket dispatch removes unconsumed launch tickets when the native run fails or finishes. */
export async function finishMemoryLaunch(id: string | null): Promise<void> {
  if (id) await cache?.cancelLaunch(id).catch(() => {});
}
