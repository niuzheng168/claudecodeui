import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, readQueuedMessage, resetChatDrafts, writeDraftText, writeQueuedMessage } from '@/shared/chatDrafts';
import type { LLMProvider, SteerChatMessage } from '@/shared/types';

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
const PROJECT = { projectId: 'p', displayName: 'Project', fullPath: '/workspace/p' };
const SESSIONS = { a: { id: 'a' }, b: { id: 'b' } };
const noop = () => {};
const resolvePermissionMode = () => 'default' as const;
vi.mock('@/shared/api', () => {
  const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
  return {
    api: {
      user: {
        drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}),
        preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}),
      },
      assets: { uploadFiles: mocks.upload },
      commands: { list: () => ok({ commands: [] }) },
      providers: { skills: () => ok({ data: { skills: [] } }) },
      getFiles: () => ok([]), files: { search: () => ok({ files: [] }) },
    },
  };
});

beforeEach(() => {
  resetChatDrafts();
  vi.clearAllMocks();
  mocks.upload.mockResolvedValue({
    ok: true, json: async () => ({ attachments: [{ path: '/uploads/notes.txt', name: 'notes.txt' }] }),
  });
});

function fixture(steerMessage: SteerChatMessage = vi.fn(async () => {})) {
  const send = vi.fn();
  const echo = vi.fn();
  const processing = vi.fn();
  const view = renderHook(
    ({ sessionId, provider, busy }: { sessionId: string; provider: LLMProvider; busy: boolean }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSIONS[sessionId as keyof typeof SESSIONS], currentSessionId: sessionId,
      provider, permissionMode: 'default', cyclePermissionMode: noop,
      resolvePermissionModeForProvider: resolvePermissionMode, currentProviderModel: 'test-model',
      currentProviderEffort: 'high', isLoading: busy, canAbortSession: busy, tokenBudget: null,
      sendMessage: send, steerMessage, onSessionProcessing: processing,
      scrollToBottom: noop, addMessage: echo, setIsUserScrolledUp: noop,
      setPendingPermissionRequests: noop,
    }),
    { initialProps: { sessionId: 'a', provider: 'codex' as LLMProvider, busy: true } },
  );
  return { ...view, send, echo, processing, steerMessage };
}

test('a correction clears only on acceptance, without queueing, a new-run marker or optimistic echo', async () => {
  let accept!: () => void;
  const request = new Promise<void>((resolve) => { accept = resolve; });
  const steer = vi.fn(() => request);
  const view = fixture(steer);
  act(() => view.result.current.setInput('Focus on tests'));
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.handleSteer(); });
  expect(view.result.current.input).toBe('Focus on tests');
  expect(readDraftText('a')).toBe('Focus on tests');
  expect(view.result.current.isSteering).toBe(true);
  expect(steer).toHaveBeenCalledWith('a', 'Focus on tests', []);
  await act(async () => {
    await view.result.current.handleSteer();
    await view.result.current.handleSubmit({ preventDefault() {} } as never);
  });
  expect(steer).toHaveBeenCalledTimes(1);
  expect(readQueuedMessage('a')).toBeNull();
  await act(async () => { accept(); await submission; });
  expect(view.result.current.input).toBe('');
  expect(readDraftText('a')).toBe('');
  expect(view.result.current.isSteering).toBe(false);
  expect(view.send).not.toHaveBeenCalled();
  expect(view.echo).not.toHaveBeenCalled();
  expect(view.processing).not.toHaveBeenCalled();
});

test('rejection keeps the text, attachments and any separately queued message intact', async () => {
  writeQueuedMessage('a', { content: 'A separate next turn' });
  const view = fixture(vi.fn(async () => { throw new Error('The turn ended'); }));
  const files = [new File(['notes'], 'notes.txt', { type: 'text/plain' })];
  act(() => { view.result.current.setInput('Use these notes'); view.result.current.setAttachedFiles(files); });
  await act(async () => { await view.result.current.handleSteer(); });
  expect(view.result.current.input).toBe('Use these notes');
  expect(view.result.current.attachedFiles).toBe(files);
  expect(view.result.current.steerError).toBe('The turn ended');
  expect(readQueuedMessage('a')?.content).toBe('A separate next turn');
  expect(view.send).not.toHaveBeenCalled();
  expect(view.echo).not.toHaveBeenCalled();
});

test('successful steering uploads attachments and does not discard edits made while awaiting the ack', async () => {
  let accept!: () => void;
  const request = new Promise<void>((resolve) => { accept = resolve; });
  const steer = vi.fn(() => request);
  const view = fixture(steer);
  act(() => {
    view.result.current.setInput('First correction');
    view.result.current.setAttachedFiles([new File(['old'], 'notes.txt')]);
  });
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.handleSteer(); });
  expect(steer).toHaveBeenCalledWith('a', 'First correction', [{ path: '/uploads/notes.txt', name: 'notes.txt' }]);
  const newerFiles = [new File(['new'], 'new.txt')];
  act(() => { view.result.current.setInput('New draft'); view.result.current.setAttachedFiles(newerFiles); });
  await act(async () => { accept(); await submission; });
  expect(view.result.current.input).toBe('New draft');
  expect(readDraftText('a')).toBe('New draft');
  expect(view.result.current.attachedFiles).toBe(newerFiles);
});

test('a session switch during acknowledgement preserves the destination draft', async () => {
  let accept!: () => void;
  const request = new Promise<void>((resolve) => { accept = resolve; });
  const view = fixture(() => request);
  writeDraftText('b', 'Draft for B');
  act(() => view.result.current.setInput('Correction for A'));
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.handleSteer(); });
  view.rerender({ sessionId: 'b', provider: 'codex', busy: true });
  await act(async () => { accept(); await submission; });
  expect(view.result.current.input).toBe('Draft for B');
  expect(readDraftText('b')).toBe('Draft for B');
  expect(readDraftText('a')).toBe('');
});

test('a failed attachment upload retains the draft and never sends a partial correction', async () => {
  mocks.upload.mockRejectedValue(new Error('Upload failed'));
  const steer = vi.fn(async () => {});
  const view = fixture(steer);
  act(() => {
    view.result.current.setInput('See attachment');
    view.result.current.setAttachedFiles([new File(['file'], 'notes.txt')]);
  });
  await act(async () => { await view.result.current.handleSteer(); });
  expect(steer).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('See attachment');
  expect(view.result.current.attachedFiles).toHaveLength(1);
  expect(view.result.current.steerError).toBe('Upload failed');
});

test('the existing Send action still queues during a run', async () => {
  const steer = vi.fn(async () => {});
  const view = fixture(steer);
  act(() => view.result.current.setInput('Do this next'));
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  expect(readQueuedMessage('a')?.content).toBe('Do this next');
  expect(view.result.current.input).toBe('');
  expect(steer).not.toHaveBeenCalled();
  expect(view.send).not.toHaveBeenCalled();
});

test('idle or non-Codex sessions cannot be steered', async () => {
  const steer = vi.fn(async () => {});
  const view = fixture(steer);
  act(() => view.result.current.setInput('Not a correction'));
  view.rerender({ sessionId: 'a', provider: 'codex', busy: false });
  await act(async () => { await view.result.current.handleSteer(); });
  view.rerender({ sessionId: 'a', provider: 'claude', busy: true });
  await act(async () => { await view.result.current.handleSteer(); });
  expect(steer).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('Not a correction');
});

test('acceptance preserves a separately queued next-turn message', async () => {
  writeQueuedMessage('a', { content: 'Do this after the current turn' });
  const view = fixture();
  act(() => view.result.current.setInput('Adjust this turn now'));
  await act(async () => { await view.result.current.handleSteer(); });
  expect(view.result.current.input).toBe('');
  expect(readQueuedMessage('a')?.content).toBe('Do this after the current turn');
  expect(view.result.current.queuedDraft?.content).toBe('Do this after the current turn');
});
