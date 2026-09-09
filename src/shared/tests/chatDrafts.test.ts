import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Drafts moved out of the browser and into auth.db so a message half-typed on
 * one device can be finished on another — the case the composer could not serve
 * at all before, because a draft only existed on the machine it was typed on.
 *
 * Each test loads a fresh module copy, because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedDraft = { scope: string; text: string; queuedMessage?: unknown };

const savedDrafts: SavedDraft[] = [];
const deletedScopes: string[] = [];
let serverDrafts: unknown[] = [];
let draftsRequestFailed = false;

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      drafts: async () => {
        if (draftsRequestFailed) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ success: true, drafts: serverDrafts }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      saveDraft: async (scope: string, draft: { text: string; queuedMessage?: unknown }) => {
        savedDrafts.push({ scope, ...draft });
        return new Response('{}', { status: 200 });
      },
      deleteDraft: async (scope: string) => {
        deletedScopes.push(scope);
        return new Response('{}', { status: 200 });
      },
    },
  },
}));

const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/chatDrafts');
};

beforeEach(() => {
  localStorage.clear();
  savedDrafts.length = 0;
  deletedScopes.length = 0;
  serverDrafts = [];
  draftsRequestFailed = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a draft is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'half a thought');

  assert.equal(store.readDraftText('session-a'), 'half a thought');
  assert.deepEqual(savedDrafts, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [
    { scope: 'session-a', text: 'half a thought', queuedMessage: null, preserveQueuedMessage: true },
  ]);
});

test('each session keeps its own draft', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'for A');
  store.writeDraftText('session-b', 'for B');

  assert.equal(store.readDraftText('session-a'), 'for A');
  assert.equal(store.readDraftText('session-b'), 'for B');
});

test('a chat with no session yet is scoped to its project', async () => {
  const store = await loadStore();

  store.writeDraftText('project:p1', 'unsent');

  assert.equal(store.readDraftText('project:p1'), 'unsent');
  assert.equal(store.readDraftText('session-a'), '');
});

test('clearing textarea text preserves any server-owned queue and lets the server clean up empty rows', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'typed');
  await vi.advanceTimersByTimeAsync(1_500);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_500);

  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '', queuedMessage: null, preserveQueuedMessage: true }]);
  assert.deepEqual(deletedScopes, []);
});

test('a draft written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeDraftText('session-a', 'survives a reload');

  // No hydrate: this is the first paint of the next load, before any request
  // could have resolved.
  const second = await loadStore();
  assert.equal(second.readDraftText('session-a'), 'survives a reload');
});

test('hydrate brings in a draft typed on another device', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'typed on the laptop', queuedMessage: null }];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'typed on the laptop');
});

test('hydrate removes a mirrored queue after the server claims it', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { content: 'server-owned queue' });
  await store.flushChatDraft('session-a');
  assert.equal(store.readQueuedMessage('session-a')?.content, 'server-owned queue');

  serverDrafts = [];
  await store.hydrateChatDrafts();

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('hydrate does not overwrite a scope the user is typing into right now', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessage: null }];

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'what I am writing');
});

test('a failed hydrate keeps the mirrored draft rather than blanking the composer', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'local work');
  await vi.advanceTimersByTimeAsync(1_500);

  draftsRequestFailed = true;
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'local work');
});

test('a queued message round-trips alongside the draft text', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'still editing');
  store.writeQueuedMessage('session-a', { content: 'send this next', attachments: [] });

  assert.equal(store.readDraftText('session-a'), 'still editing');
  assert.deepEqual(store.readQueuedMessage('session-a'), {
    content: 'send this next',
    attachments: [],
  });
  assert.equal(savedDrafts.length, 1, 'queue actions persist without waiting for the draft debounce');
  assert.deepEqual(savedDrafts, [{
    scope: 'session-a',
    text: 'still editing',
    queuedMessage: { content: 'send this next', attachments: [] },
  }]);
});

test('a queued message with neither text nor attachments reads as absent', async () => {
  const store = await loadStore();

  store.writeQueuedMessage('session-a', { content: '   ', attachments: [] });

  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('legacy image-only descriptors are still readable as attachments', async () => {
  const store = await loadStore();

  store.writeQueuedMessage('session-a', { content: '', images: [{ name: 'shot.png' }] });

  assert.deepEqual(store.readQueuedMessage('session-a')?.attachments, [{ name: 'shot.png' }]);
});

test('clearing the queued message leaves the draft text alone', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'keep me');
  store.writeQueuedMessage('session-a', { content: 'queued' });

  store.clearQueuedMessage('session-a');

  assert.equal(store.readQueuedMessage('session-a'), null);
  assert.equal(store.readDraftText('session-a'), 'keep me');
});

test('subscribers are notified on a write', async () => {
  const store = await loadStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribeToChatDrafts(listener);

  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  // Writing the same text again changes nothing, so nobody is woken.
  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  unsubscribe();
  store.writeDraftText('session-a', 'more');
  assert.equal(listener.mock.calls.length, 1);
});

test('reset clears the drafts so the next user does not see them', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'private');

  store.resetChatDrafts();

  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test('queue writes are ordered and the flush barrier waits for earlier saves', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  let release!: (response: Response) => void;
  const request = new Promise<Response>((resolve) => { release = resolve; });
  const save = vi.spyOn(api.user, 'saveDraft').mockReturnValueOnce(request);
  store.writeQueuedMessage('session-a', { id: 'first', content: 'first' });
  store.writeQueuedMessage('session-a', { id: 'second', content: 'second' });
  const flushed = store.flushChatDraft('session-a');
  assert.equal(save.mock.calls.length, 1);
  release(new Response('{}'));
  await flushed;
  assert.equal(save.mock.calls.length, 2);
  assert.deepEqual(save.mock.calls[1][1], {
    text: '', queuedMessage: { id: 'second', content: 'second' },
  });
});

test('text autosaves never rewrite a queue and forgetting acceptance issues no deletion', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { id: 'q', content: 'queued' });
  await store.flushChatDraft('session-a');
  const receipt = store.readQueuedMessage('session-a')!;
  savedDrafts.length = 0;
  store.writeDraftText('session-a', 'my next draft');
  assert.equal(store.forgetQueuedMessage('session-a', receipt), true);
  await store.flushChatDraft('session-a');
  assert.deepEqual(savedDrafts, [{
    scope: 'session-a', text: 'my next draft', queuedMessage: null, preserveQueuedMessage: true,
  }]);
  assert.deepEqual(deletedScopes, []);
  assert.equal(store.readDraftText('session-a'), 'my next draft');
});

test('a late acceptance cannot delete a newer, identical-looking queue', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { id: 'old', content: 'same text' });
  const receipt = store.readQueuedMessage('session-a')!;
  store.writeQueuedMessage('session-a', { id: 'new', content: 'same text' });
  assert.equal(store.forgetQueuedMessage('session-a', receipt), false);
  assert.equal(store.readQueuedMessage('session-a')?.id, 'new');
  await store.flushChatDraft('session-a');
});

test('hydration cannot resurrect a queue consumed while its request was in flight', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  store.writeQueuedMessage('session-a', { id: 'q', content: 'queued' });
  await store.flushChatDraft('session-a');
  const receipt = store.readQueuedMessage('session-a')!;
  let resolve!: (response: Response) => void;
  vi.spyOn(api.user, 'drafts').mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const hydrate = store.hydrateChatDrafts();
  store.forgetQueuedMessage('session-a', receipt);
  resolve(new Response(JSON.stringify({ drafts: [{ scope: 'session-a', text: '', queuedMessage: receipt }] })));
  await hydrate;
  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('hydration leaves a pending queue save intact', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  let resolve!: (response: Response) => void;
  vi.spyOn(api.user, 'saveDraft').mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  store.writeQueuedMessage('session-a', { id: 'q', content: 'queued' });
  await store.hydrateChatDrafts();
  assert.equal(store.readQueuedMessage('session-a')?.id, 'q');
  resolve(new Response('{}'));
  await store.flushChatDraft('session-a');
});

test('holding an uncertain receipt only updates the mirror, never requeues it', async () => {
  const store = await loadStore();
  store.writeQueuedMessage('session-a', { id: 'q', content: 'queued' });
  await store.flushChatDraft('session-a');
  savedDrafts.length = 0;
  store.holdQueuedMessage('session-a', store.readQueuedMessage('session-a')!);
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(store.readQueuedMessage('session-a')?.steerHold, 'unconfirmed');
  assert.deepEqual(savedDrafts, []);
});

test('deferred writes and hydration from an old login do not enter the next login', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  let saveDone!: (response: Response) => void;
  let hydrateDone!: (response: Response) => void;
  const save = vi.spyOn(api.user, 'saveDraft').mockImplementationOnce(() => new Promise((done) => { saveDone = done; }));
  vi.spyOn(api.user, 'drafts').mockImplementationOnce(() => new Promise((done) => { hydrateDone = done; }));
  const hydrate = store.hydrateChatDrafts();
  store.writeQueuedMessage('session-a', { content: 'first' });
  store.writeQueuedMessage('session-a', { content: 'deferred secret' });
  const writing = store.flushChatDraft('session-a');
  store.resetChatDrafts();
  saveDone(new Response('{}'));
  hydrateDone(new Response(JSON.stringify({ drafts: [{ scope: 'session-a', text: 'private' }] })));
  await Promise.all([writing, hydrate]);
  assert.equal(save.mock.calls.length, 1);
  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(store.readQueuedMessage('session-a'), null);
});

test('a failed queue save cannot be retried or hidden by a later text-only autosave', async () => {
  const store = await loadStore();
  const { api } = await import('@/shared/api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const save = vi.spyOn(api.user, 'saveDraft').mockRejectedValueOnce(new Error('Response lost'));
  store.writeQueuedMessage('session-a', { id: 'q', content: 'queued' });
  store.writeDraftText('session-a', 'new typing');
  await assert.rejects(store.flushChatDraft('session-a'), /not confirmed/);
  assert.equal(save.mock.calls.length, 2);
  assert.equal(save.mock.calls[1][1].preserveQueuedMessage, true);
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(save.mock.calls.length, 2, 'no silent retry of the queue');
  await store.hydrateChatDrafts();
  assert.equal(store.readQueuedMessage('session-a')?.id, 'q', 'keep unconfirmed input for explicit review');
  serverDrafts = [{ scope: 'session-a', text: 'new typing', queuedMessage: { id: 'q', content: 'queued' } }];
  await store.hydrateChatDrafts();
  await store.flushChatDraft('session-a'); // Matching authoritative receipt resolves the lost save response.
});
