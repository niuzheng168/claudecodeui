import { api } from '@/shared/api';
import type { StoredQueuedMessage } from '@/shared/types';
import { deploymentStorageKey } from '@/shared/utils';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

type DraftRecord = {
  text: string;
  queuedMessage: StoredQueuedMessage | null;
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

// Each node owns its mirror, even when all iframes load the same shared JS bundle.
const mirrorStorageKey = deploymentStorageKey('chat-drafts');

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessage: null };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
// Only explicit queue actions may replace server-owned queued input; typing must never resurrect it.
const pendingQueuedScopes = new Set<string>();
// Writes are ordered per session, and immediate steering waits for its queue receipt to reach the server.
const serverWrites = new Map<string, Promise<void>>();
// A lost queue-save response must not be retried by a later textarea autosave:
// the server might already have consumed it. Explicit edits or a matching hydrate resolve it.
const queuedWriteFailures = new Map<string, { message: StoredQueuedMessage | null; error: Error }>();
// Hydration and failed writes must not roll back a newer edit or a confirmed server-side queue claim.
const revisions = new Map<string, number>();
// Deferred writes from a previous login must not start using the next login's credentials.
let draftEpoch = 0;
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessage === null
);

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(mirrorStorageKey);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessage: isRecord(value.queuedMessage)
          ? (value.queuedMessage as StoredQueuedMessage)
          : null,
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(mirrorStorageKey, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  const scopes = [...pendingScopes];
  pendingScopes.clear();

  for (const scope of scopes) {
    const draft = drafts.get(scope) ?? EMPTY_DRAFT;
    const writesQueue = pendingQueuedScopes.delete(scope);
    const revision = revisions.get(scope);
    const epoch = draftEpoch;
    const payload = {
      text: draft.text,
      // Older nodes still receive the complete snapshot. New nodes ignore this
      // field for text-only saves, so a late autosave cannot undo a queue claim.
      queuedMessage: draft.queuedMessage,
      ...(!writesQueue ? { preserveQueuedMessage: true } : {}),
    };
    const save = async () => {
      if (epoch !== draftEpoch) return;
      const response = await api.user.saveDraft(scope, payload);
      if (!response.ok) throw new Error('Failed to save chat draft');
    };
    const previous = serverWrites.get(scope);
    const request = previous ? previous.catch(() => {}).then(save) : save();
    const writing = request.then(() => {
      if (serverWrites.get(scope) === writing) serverWrites.delete(scope);
    }, (error: unknown) => {
      if (serverWrites.get(scope) === writing) serverWrites.delete(scope);
      if (epoch === draftEpoch) {
        if (writesQueue && (drafts.get(scope)?.queuedMessage ?? null) === draft.queuedMessage) {
          queuedWriteFailures.set(scope, {
            message: draft.queuedMessage,
            error: new Error('Queue save was not confirmed. Check the conversation before editing and resending.'),
          });
        } else if (!writesQueue && revisions.get(scope) === revision) {
          pendingScopes.add(scope);
        }
        console.error('Failed to save chat draft:', error);
      }
      throw error;
    });
    serverWrites.set(scope, writing);
    void writing.catch(() => {}); // Queue clicks await this failure; autosaves must not create unhandled rejections.
  }
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function flushServerWritesNow(): void {
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  flushServerWrites();
}

function updateDraft(scope: string, update: Partial<DraftRecord>, persist = true): void {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && next.queuedMessage === current.queuedMessage) {
    return;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;
  revisions.set(scope, (revisions.get(scope) ?? 0) + 1);

  writeMirror();
  if (Object.prototype.hasOwnProperty.call(update, 'queuedMessage')) queuedWriteFailures.delete(scope);
  if (persist) {
    if (Object.prototype.hasOwnProperty.call(update, 'queuedMessage')) pendingQueuedScopes.add(scope);
    queueServerWrite(scope);
  }
  notifyListeners();
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  updateDraft(scope, { text });
}

export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  const queued = drafts.get(scope)?.queuedMessage ?? null;
  if (!queued) {
    return null;
  }

  const attachments = Array.isArray(queued.attachments)
    ? queued.attachments
    : Array.isArray(queued.images)
      ? queued.images
      : [];

  // A queued message with neither text nor attachments has nothing to send.
  return queued.content.trim() || attachments.length > 0
    ? { ...queued, attachments }
    : null;
}

export function writeQueuedMessage(scope: string, message: StoredQueuedMessage): void {
  updateDraft(scope, { queuedMessage: message });
  // Queueing is a send-like action, so persist it before the tab can close.
  flushServerWritesNow();
}

export function clearQueuedMessage(scope: string): void {
  updateDraft(scope, { queuedMessage: null });
  // Editing or cancelling must beat the server's next dispatcher poll.
  flushServerWritesNow();
}

/** Chat's queued steering waits for prior queue saves without blocking writes to other sessions. */
export async function flushChatDraft(scope: string): Promise<void> {
  flushServerWritesNow();
  await serverWrites.get(scope);
  const failedQueue = queuedWriteFailures.get(scope);
  if (failedQueue) throw failedQueue.error;
}

/** Chat forgets only the receipt consumed by the server; it must not issue a second queue deletion. */
export function forgetQueuedMessage(scope: string, expected: StoredQueuedMessage): boolean {
  if (JSON.stringify(readQueuedMessage(scope)) !== JSON.stringify(expected)) return false;
  updateDraft(scope, { queuedMessage: null }, false);
  return true;
}

/** Chat marks an uncertain local receipt for review without resurrecting it on the server. */
export function holdQueuedMessage(scope: string, expected: StoredQueuedMessage): void {
  if (JSON.stringify(readQueuedMessage(scope)) !== JSON.stringify(expected)) return;
  updateDraft(scope, { queuedMessage: { ...expected, steerHold: 'unconfirmed' } }, false);
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * A scope the client has typed into since this page loaded is left alone: the
 * user is looking at that composer right now, and replacing its contents with a
 * staler server copy would delete what they are in the middle of writing.
 */
export async function hydrateChatDrafts(): Promise<void> {
  const epoch = draftEpoch;
  const startedRevisions = new Map(revisions);
  const writingScopes = new Set(serverWrites.keys());
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessage?: unknown }> = [];

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }
  if (epoch !== draftEpoch) return;
  const locallyChanged = (scope: string) => pendingScopes.has(scope) || writingScopes.has(scope)
    || serverWrites.has(scope) || queuedWriteFailures.has(scope) || startedRevisions.get(scope) !== revisions.get(scope);

  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    const failedQueue = queuedWriteFailures.get(scope);
    if (failedQueue && JSON.stringify(draft.queuedMessage) === JSON.stringify(failedQueue.message)) {
      queuedWriteFailures.delete(scope); // An authoritative read confirms the earlier save reached the server.
    }
    if (!scope || locallyChanged(scope)) {
      continue;
    }

    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessage: isRecord(draft.queuedMessage)
        ? (draft.queuedMessage as StoredQueuedMessage)
        : null,
    });
  }

  // Local edits whose debounced write has not left the browser yet win over
  // the server snapshot. Every other missing scope was deleted remotely and
  // must also disappear from the mirror.
  for (const [scope, pending] of drafts) {
    if (locallyChanged(scope)) merged.set(scope, pending);
  }

  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  draftEpoch += 1;
  drafts = new Map();
  pendingScopes.clear();
  pendingQueuedScopes.clear();
  serverWrites.clear();
  queuedWriteFailures.clear();
  revisions.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(mirrorStorageKey);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
