import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A Claude turn the node refused because `claude` in a terminal has the
 * session open asks whether to end that process; confirming resends the same
 * turn, with the same identity, as one that may take the session over.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const render = (sendMessage: (message: unknown) => void) => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: SESSION,
  currentSessionId: SESSION.id ?? null,
  provider: 'claude',
  permissionMode: 'default',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'default' as PermissionMode,
  currentProviderModel: 'model-1',
  currentProviderEffort: 'medium',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage,
  scrollToBottom: () => undefined,
  addMessage: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
}));

type View = ReturnType<typeof render>;

const submit = async (view: View, text: string) => {
  await act(async () => { view.result.current.setInput(text); });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

beforeEach(() => {
  resetChatDrafts();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatDrafts();
  localStorage.clear();
});

test('confirming resends the refused turn as one that takes the session over', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = render((message) => { sent.push(message as Record<string, unknown>); });
  await submit(view, 'continue here');
  const [first] = sent;
  assert.equal(first.type, 'chat.send');

  act(() => {
    view.result.current.askToTakeOverSession('session-1', {
      pid: 4242, entrypoint: 'cli', messageId: String(first.clientMessageId),
    });
  });
  assert.deepEqual(view.result.current.takeOverPrompt, { sessionId: 'session-1', pid: 4242, entrypoint: 'cli' });

  act(() => { view.result.current.resolveTakeOverPrompt(true); });
  assert.equal(view.result.current.takeOverPrompt, null);
  assert.equal(sent.length, 2);
  const resent = sent[1];
  assert.equal(resent.clientMessageId, first.clientMessageId);
  assert.equal(resent.content, 'continue here');
  assert.equal((resent.options as Record<string, unknown>).takeOver, true);

  // Answered once: the same refusal replayed later does not ask again.
  act(() => {
    view.result.current.askToTakeOverSession('session-1', {
      pid: 4242, entrypoint: 'cli', messageId: String(first.clientMessageId),
    });
  });
  assert.equal(view.result.current.takeOverPrompt, null);
});

test('a refusal of another send, or a cancelled prompt, sends nothing', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = render((message) => { sent.push(message as Record<string, unknown>); });
  await submit(view, 'continue here');

  act(() => {
    view.result.current.askToTakeOverSession('session-1', { pid: 4242, entrypoint: 'cli', messageId: 'another-tab' });
  });
  assert.equal(view.result.current.takeOverPrompt, null);

  act(() => {
    view.result.current.askToTakeOverSession('session-1', {
      pid: 4242, entrypoint: 'cli', messageId: String(sent[0].clientMessageId),
    });
  });
  act(() => { view.result.current.resolveTakeOverPrompt(false); });
  assert.equal(view.result.current.takeOverPrompt, null);
  assert.equal(sent.length, 1);
});
