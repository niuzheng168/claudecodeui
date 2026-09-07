import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Drafts used to be keyed by project, so every session in a project shared one
 * draft and switching sessions carried the previous one's half-typed message
 * across. They are keyed by session now (and by project only for a chat that
 * has not been sent yet), which is what lets a draft be picked up on another
 * device against the session it belongs to.
 *
 * These tests drive the real hook, so the effect ordering that decides which
 * scope a keystroke lands in is exercised rather than described.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

// The composer only ever reaches the network through these; stubbing them keeps
// the test about draft scoping rather than about fetch behaviour in jsdom.
vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      providers: { skills: () => okJson({ data: { skills: [] } }) },
      getFiles: () => okJson([]),
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

const renderComposer = (selectedSession: ProjectSession | null, cycleMode = () => undefined) => renderHook(
  ({ session }: { session: ProjectSession | null }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: cycleMode,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
  { initialProps: { session: selectedSession } },
);

function keyEvent(key: string, overrides = {}): KeyboardEvent<HTMLTextAreaElement> {
  return {
    key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false,
    nativeEvent: { isComposing: false, keyCode: 0 }, getModifierState: () => false,
    preventDefault: vi.fn(), ...overrides,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

test('Ctrl+Alt+M alone cycles permissions once; Tab and browser navigation chords are not mode switches', () => {
  const cycle = vi.fn();
  const view = renderComposer({ id: 'shortcut-test' }, cycle);
  const chord = keyEvent('m', { ctrlKey: true, altKey: true });
  act(() => view.result.current.handleKeyDown(chord));
  assert.equal(cycle.mock.calls.length, 1);
  assert.equal(vi.mocked(chord.preventDefault).mock.calls.length, 1);
  act(() => view.result.current.handleKeyDown(keyEvent('m', { ctrlKey: true, altKey: true, repeat: true })));
  assert.equal(cycle.mock.calls.length, 1);
  for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }]) {
    const event = keyEvent('Tab', modifiers);
    act(() => view.result.current.handleKeyDown(event));
    assert.equal(vi.mocked(event.preventDefault).mock.calls.length, 0);
  }
  assert.equal(cycle.mock.calls.length, 1);
});

test('IME composition and AltGr cannot accidentally switch modes or submit', () => {
  const cycle = vi.fn();
  const view = renderComposer({ id: 'ime-shortcut-test' }, cycle);
  for (const event of [
    keyEvent('m', { ctrlKey: true, altKey: true, getModifierState: () => true }),
    keyEvent('m', { ctrlKey: true, altKey: true, nativeEvent: { isComposing: true } }),
    keyEvent('Enter', { nativeEvent: { isComposing: true } }),
    keyEvent('Tab', { nativeEvent: { keyCode: 229 } }),
  ]) {
    act(() => view.result.current.handleKeyDown(event));
    assert.equal(vi.mocked(event.preventDefault).mock.calls.length, 0);
  }
  assert.equal(cycle.mock.calls.length, 0);
});

beforeEach(() => {
  localStorage.clear();
  // The drafts store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's drafts into the next.
  resetChatDrafts();
});

test('a draft is stored under the open session, not the project', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });

  assert.equal(readDraftText('session-a'), 'for session A');
  assert.equal(readDraftText(`project:${PROJECT.projectId}`), '');
});

test('a chat with no session yet is stored under its project', async () => {
  const view = renderComposer(null);

  await act(async () => {
    view.result.current.setInput('not sent yet');
  });

  assert.equal(readDraftText(`project:${PROJECT.projectId}`), 'not sent yet');
});

test('switching sessions swaps the draft instead of carrying it across', async () => {
  writeDraftText('session-b', 'for session B');
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });

  await act(async () => {
    view.rerender({ session: { id: 'session-b' } });
  });

  assert.equal(view.result.current.input, 'for session B');
  assert.equal(
    readDraftText('session-a'),
    'for session A',
    "the previous session's draft must survive the switch",
  );
  assert.equal(
    readDraftText('session-b'),
    'for session B',
    "the new session's draft must not be overwritten by the previous one's text",
  );
});

test('switching back restores the draft that was left behind', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });
  await act(async () => {
    view.rerender({ session: { id: 'session-b' } });
  });
  await act(async () => {
    view.rerender({ session: { id: 'session-a' } });
  });

  assert.equal(view.result.current.input, 'for session A');
});

test('a draft written on another device is picked up while the session is open', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    // Stands in for a hydrate delivering what was typed elsewhere.
    writeDraftText('session-a', 'typed on the phone');
  });

  assert.equal(view.result.current.input, 'typed on the phone');
});

test('clearing the composer clears that session\'s stored draft', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('typed');
  });
  assert.equal(readDraftText('session-a'), 'typed');

  await act(async () => {
    view.result.current.setInput('');
  });

  assert.equal(readDraftText('session-a'), '');
});

test('voice insertion provides an exact receipt and rewrite/undo preserves the typed prefix', async () => {
  const view = renderComposer({ id: 'session-a' });
  await act(async () => view.result.current.setInput('Typed prefix.'));
  let receipt = { prefix: '', transcript: '', draft: '' };
  await act(async () => { receipt = view.result.current.handleVoiceTranscript('呃，检查配置。', false); });
  assert.deepEqual(receipt, { prefix: 'Typed prefix. ', transcript: '呃，检查配置。', draft: 'Typed prefix. 呃，检查配置。' });
  await act(async () => view.result.current.replaceVoiceDraft(receipt.draft, receipt.prefix + '请检查配置。'));
  assert.equal(view.result.current.input, 'Typed prefix. 请检查配置。');
  assert.equal(readDraftText('session-a'), view.result.current.input);
  await act(async () => view.result.current.replaceVoiceDraft('Typed prefix. 请检查配置。', receipt.draft));
  assert.equal(view.result.current.input, receipt.draft);
});

test('a queued edit wins over rewrite even before React commits the changed draft', async () => {
  const view = renderComposer({ id: 'session-a' });
  await act(async () => view.result.current.setInput('old text'));
  await act(async () => {
    view.result.current.setInput('new user edit');
    view.result.current.replaceVoiceDraft('old text', 'model replacement');
  });
  assert.equal(view.result.current.input, 'new user edit');
});

test('a rewrite callback from another session cannot update an identical-looking draft', async () => {
  writeDraftText('session-b', 'same text');
  const view = renderComposer({ id: 'session-a' });
  await act(async () => view.result.current.setInput('same text'));
  const replaceOldDraft = view.result.current.replaceVoiceDraft;
  await act(async () => view.rerender({ session: { id: 'session-b' } }));
  await act(async () => replaceOldDraft('same text', 'wrong session replacement'));
  assert.equal(view.result.current.input, 'same text');
  assert.equal(readDraftText('session-b'), 'same text');
});
