import { sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import { generateClaudeSessionTitle } from '@/modules/providers/list/claude/claude-title-generator.service.js';
import type { NewSessionTitleRequest } from '@/shared/index.js';

type TitleSession = Pick<NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  'session_id' | 'provider' | 'provider_session_id' | 'custom_name' | 'custom_name_source'
  | 'forked_from_session_id' | 'isArchived' | 'model'>;

type TitleDependencies = {
  generate: typeof generateClaudeSessionTitle;
  getSession: (sessionId: string) => TitleSession | null;
  updateTitle: typeof sessionsDb.updateSessionSyncedName;
  notify: (sessionId: string) => Promise<void>;
  warn: (message: string) => void;
  timeoutMs: number;
};

const UNAVAILABLE = '[Claude] Automatic title unavailable; the conversation is unaffected.';

/**
 * Used by the provider runtime dispatcher to name new Codey Claude sessions on
 * managed nodes, and by provider tests with injected stores and transports.
 * Work is deduplicated, bounded and best-effort with no retry. The title is
 * cached only in Codey's database while the name is still automatic; nothing
 * is written into Claude's transcript, so a later native /rename still wins.
 */
export function createClaudeSessionTitleService(overrides: Partial<TitleDependencies> = {}) {
  const dependencies: TitleDependencies = {
    generate: generateClaudeSessionTitle,
    getSession: id => sessionsDb.getSessionById(id),
    updateTitle: (id, name, providerId) => sessionsDb.updateSessionSyncedName(id, name, providerId),
    notify: broadcastSessionUpserted, warn: message => console.warn(message),
    timeoutMs: 30_000, ...overrides,
  };
  const jobs = new Map<string, Promise<void>>();
  const pending: Array<() => void> = [];
  let active = 0;

  function eligible(input: NewSessionTitleRequest): TitleSession | null {
    const row = dependencies.getSession(input.sessionId);
    return row?.provider === 'claude' && row.session_id !== input.providerSessionId
      && row.provider_session_id === input.providerSessionId && row.model
      && !row.isArchived && !row.forked_from_session_id && row.custom_name_source === 'auto'
      ? row : null;
  }

  async function generate(input: NewSessionTitleRequest): Promise<void> {
    const row = eligible(input);
    if (!row?.model) return;
    // The generator's request and body read both stop at this deadline.
    const signal = AbortSignal.timeout(dependencies.timeoutMs);
    try {
      const title = await dependencies.generate({ message: input.initialMessage, model: row.model, signal });
      signal.throwIfAborted();
      // A rename, archive or adopted native title while the model worked wins.
      // The SQL guard repeats the automatic-name check in the same write.
      const latest = eligible(input);
      if (!title || !latest || latest.custom_name !== row.custom_name) return;
      if (dependencies.updateTitle(input.sessionId, title, input.providerSessionId)) {
        await dependencies.notify(input.sessionId);
      }
    } catch {
      // Do not log the prompt, generated text, gateway response or credentials.
      dependencies.warn(UNAVAILABLE);
    }
  }

  function drain(): void {
    while (active < 2 && pending.length) pending.shift()!();
  }

  return {
    schedule(input: NewSessionTitleRequest): Promise<void> {
      const existing = jobs.get(input.providerSessionId);
      if (existing) return existing;
      if (!input.initialMessage.trim() || jobs.size >= 32) return Promise.resolve();
      const bounded = { ...input, initialMessage: input.initialMessage.trim().slice(0, 4_000) };
      let finish = () => {};
      const done = new Promise<void>(resolve => { finish = resolve; });
      jobs.set(input.providerSessionId, done);
      pending.push(() => {
        active += 1;
        void generate(bounded).catch(() => dependencies.warn(UNAVAILABLE)).finally(() => {
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
export const claudeSessionTitleService = createClaudeSessionTitleService();
