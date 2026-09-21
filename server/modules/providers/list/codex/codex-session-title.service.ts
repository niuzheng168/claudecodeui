import { sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import { connectCodexNativeClient } from '@/modules/providers/list/codex/codex-native-client.service.js';
import { generateCodexSessionTitle } from '@/modules/providers/list/codex/codex-title-generator.service.js';
import type { ICodexRpcClient, NewCodexSessionTitleRequest } from '@/shared/index.js';

type TitleSession = Pick<NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  'session_id' | 'provider' | 'provider_session_id' | 'project_path' | 'custom_name_source'
  | 'forked_from_session_id' | 'isArchived' | 'model'>;

type TitleDependencies = {
  connect: () => Promise<ICodexRpcClient | null>;
  generate: typeof generateCodexSessionTitle;
  getSession: (sessionId: string) => TitleSession | null;
  updateTitle: typeof sessionsDb.updateSessionSyncedName;
  notify: (sessionId: string) => Promise<void>;
  warn: (message: string) => void;
  timeoutMs: number;
};

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Used by the provider runtime dispatcher to name newly created Codey threads,
 * and by provider tests with isolated stores/transports. Work is deduplicated,
 * bounded and best-effort. No resume, turn, writer takeover, direct native DB write or
 * automatic retry is used; only the native metadata RPC may assign a name.
 */
export function createCodexSessionTitleService(overrides: Partial<TitleDependencies> = {}) {
  const dependencies: TitleDependencies = {
    connect: connectCodexNativeClient, generate: generateCodexSessionTitle,
    getSession: id => sessionsDb.getSessionById(id),
    updateTitle: (id, name, providerId) => sessionsDb.updateSessionSyncedName(id, name, providerId),
    notify: broadcastSessionUpserted, warn: message => console.warn(message),
    timeoutMs: 30_000, ...overrides,
  };
  const jobs = new Map<string, Promise<void>>();
  const pending: Array<() => void> = [];
  let active = 0;

  function eligible(input: NewCodexSessionTitleRequest): TitleSession | null {
    const row = dependencies.getSession(input.sessionId);
    return row?.provider === 'codex' && row.session_id !== input.providerSessionId
      && row.provider_session_id === input.providerSessionId && row.project_path
      && !row.isArchived && !row.forked_from_session_id && row.custom_name_source === 'auto'
      ? row : null;
  }

  async function generate(input: NewCodexSessionTitleRequest): Promise<void> {
    const row = eligible(input);
    if (!row) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new Error('Automatic title deadline exceeded')), dependencies.timeoutMs);
    timer.unref();
    let client: ICodexRpcClient | null = null;
    let unsubscribe = () => {};
    let unsubscribeDisconnect = () => {};
    let candidate: string | null = null;
    try {
      const connection = dependencies.connect();
      // A handshake may finish after the job timed out. Close only our late
      // reader, never leave it running or attach it to a user's turn.
      void connection.then(late => {
        if (signal.aborted) return late?.close();
      }).catch(() => {});
      client = await abortable(connection, signal);
      if (!client) return;
      const rpc = client;
      unsubscribeDisconnect = rpc.onDisconnect(() => controller.abort(new Error('Native metadata reader disconnected')));
      unsubscribe = rpc.onNotification((method, params) => {
        if (method === 'thread/name/updated' && params.threadId === input.providerSessionId
          && typeof params.threadName === 'string' && params.threadName.trim()
          && params.threadName !== candidate) controller.abort(new Error('Thread was named elsewhere'));
      });
      const read = () => abortable(rpc.request('thread/read', {
        threadId: input.providerSessionId, includeTurns: false,
      }), signal);
      const first = await read();
      if (first.thread?.id !== input.providerSessionId || first.thread.name?.trim()
        || typeof first.thread.modelProvider !== 'string') return;
      const result = await abortable(rpc.request('config/read', {
        cwd: row.project_path, includeLayers: false,
      }), signal);
      if (!eligible(input)) return;
      candidate = await abortable(dependencies.generate({
        message: input.initialMessage, model: row.model || result.config?.model || '',
        modelProvider: first.thread.modelProvider, config: result.config ?? {}, signal,
      }), signal);
      if (!candidate || !eligible(input)) return;

      // Both desktop and Codey users can rename while the model is working.
      // Native naming has no compare-and-set RPC: re-read immediately before
      // its single write, and never replace any observed non-empty name.
      const latest = await read();
      if (latest.thread?.id !== input.providerSessionId || latest.thread.name?.trim()
        || !eligible(input)) return;
      signal.throwIfAborted();
      await abortable(rpc.request('thread/name/set', {
        threadId: input.providerSessionId, name: candidate,
      }), signal);
      const saved = await read();
      if (saved.thread?.id !== input.providerSessionId || saved.thread.name !== candidate
        || !eligible(input)) return;
      if (dependencies.updateTitle(input.sessionId, candidate, input.providerSessionId)) {
        await dependencies.notify(input.sessionId);
      }
    } catch {
      // Do not log the prompt, generated text, provider response or credentials.
      dependencies.warn('[Codex] Automatic title unavailable; the conversation is unaffected.');
    } finally {
      clearTimeout(timer);
      unsubscribe();
      unsubscribeDisconnect();
      try { await client?.close(); } catch { /* This reader never owns a user turn. */ }
    }
  }

  function drain(): void {
    while (active < 2 && pending.length) pending.shift()!();
  }

  return {
    schedule(input: NewCodexSessionTitleRequest): Promise<void> {
      const existing = jobs.get(input.providerSessionId);
      if (existing) return existing;
      if (!input.initialMessage.trim() || jobs.size >= 32) return Promise.resolve();
      const bounded = { ...input, initialMessage: input.initialMessage.trim().slice(0, 4_000) };
      let finish = () => {};
      const done = new Promise<void>(resolve => { finish = resolve; });
      jobs.set(input.providerSessionId, done);
      pending.push(() => {
        active += 1;
        void generate(bounded).catch(() => {
          dependencies.warn('[Codex] Automatic title unavailable; the conversation is unaffected.');
        }).finally(() => {
          active -= 1;
          jobs.delete(input.providerSessionId);
          finish();
          drain();
        });
      });
      drain();
      return done;
    },
  };
}

/** Provider runtime dispatcher shares one bounded background naming queue per node process. */
export const codexSessionTitleService = createCodexSessionTitleService();
