import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const saved: unknown[] = [];
let serverPreferences: Record<string, unknown> = {};
let serverDrafts: unknown[] = [];
vi.mock('@/shared/api', () => ({
  api: { user: {
    preferences: async () => new Response(JSON.stringify({ preferences: serverPreferences })),
    savePreferences: async (value: unknown) => { saved.push(value); return new Response('{}'); },
    drafts: async () => new Response(JSON.stringify({ drafts: serverDrafts })),
    saveDraft: async () => new Response('{}'),
    deleteDraft: async () => new Response('{}'),
  } },
}));

async function loadNode(node: string) {
  Object.defineProperty(window, '__CLOUDCLI_BASE_PATH__', { value: `/cloudcli/${node}/`, configurable: true });
  vi.resetModules();
  const [drafts, preferences] = await Promise.all([
    import('@/shared/chatDrafts'),
    import('@/shared/userSettings'),
  ]);
  return { drafts, preferences };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  saved.length = 0;
  serverPreferences = {};
  serverDrafts = [];
});
afterEach(() => {
  Reflect.deleteProperty(window, '__CLOUDCLI_BASE_PATH__');
  vi.useRealTimers();
  vi.resetModules();
});

test('identical session IDs in two nodes have separate draft and preference mirrors', async () => {
  const a = await loadNode('node-a');
  a.drafts.writeDraftText('same-session-id', 'Draft for node A');
  a.preferences.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(1500);
  const b = await loadNode('node-b');
  expect(b.drafts.readDraftText('same-session-id')).toBe('');
  expect(b.preferences.readUserPreference('theme', 'light')).toBe('light');
  b.drafts.writeDraftText('same-session-id', 'Draft for node B');
  b.preferences.writeUserPreference('userLanguage', 'zh-CN');
  await vi.advanceTimersByTimeAsync(1500);
  const backToA = await loadNode('node-a');
  expect(backToA.drafts.readDraftText('same-session-id')).toBe('Draft for node A');
  expect(backToA.preferences.readUserPreference('theme', 'light')).toBe('dark');
  backToA.drafts.resetChatDrafts();
  backToA.preferences.resetUserPreferences();
  const backToB = await loadNode('node-b');
  expect(backToB.drafts.readDraftText('same-session-id')).toBe('Draft for node B');
  expect(backToB.preferences.readUserPreference('userLanguage', 'en')).toBe('zh-CN');
});

test('unscoped legacy records are neither deleted nor assigned to a guessed node', async () => {
  const oldDrafts = JSON.stringify({ 'same-session-id': { text: 'Unknown node draft' } });
  localStorage.setItem('chat-drafts', oldDrafts);
  localStorage.setItem('user-preferences', JSON.stringify({ theme: 'dark' }));
  localStorage.setItem('theme', 'dark');
  const store = await loadNode('node-a');
  expect(store.drafts.readDraftText('same-session-id')).toBe('');
  expect(store.preferences.readUserPreference('theme', 'light')).toBe('light');
  await store.preferences.hydrateUserPreferences();
  await vi.advanceTimersByTimeAsync(500);
  expect(saved).toEqual([]);
  expect(localStorage.getItem('chat-drafts')).toBe(oldDrafts);
  expect(localStorage.getItem('theme')).toBe('dark');
  serverDrafts = [{ scope: 'same-session-id', text: 'Authoritative node A draft' }];
  await store.drafts.hydrateChatDrafts();
  expect(store.drafts.readDraftText('same-session-id')).toBe('Authoritative node A draft');
  expect(localStorage.getItem('chat-drafts:cloudcli/node-a')).toContain('Authoritative node A draft');
  expect(localStorage.getItem('chat-drafts')).toBe(oldDrafts);
});
