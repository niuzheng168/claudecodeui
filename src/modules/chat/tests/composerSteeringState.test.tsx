import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { flushChatDraft, hydrateChatDrafts, readDraftText, readQueuedMessage, resetChatDrafts, writeDraftText, writeQueuedMessage } from '@/shared/chatDrafts';
import type { LLMProvider, SteerChatMessage, StoredQueuedMessage } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  save: vi.fn(),
  drafts: new Map<string, { scope: string; text: string; queuedMessage: StoredQueuedMessage | null }>(),
}));
const PROJECT = { projectId: 'p', displayName: 'Project', fullPath: '/workspace/p' };
const SESSIONS = { a: { id: 'a' }, b: { id: 'b' } };
const noop = () => {};
const resolvePermissionMode = () => 'default' as const;
vi.mock('@/shared/api', () => {
  const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
  return {
    api: {
      user: {
        drafts: () => ok({ drafts: [...mocks.drafts.values()] }), saveDraft: mocks.save,
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
  mocks.drafts.clear();
  vi.clearAllMocks();
  mocks.save.mockImplementation(async (scope, payload) => {
    mocks.drafts.set(scope, {
      scope, text: payload.text,
      queuedMessage: payload.preserveQueuedMessage
        ? mocks.drafts.get(scope)?.queuedMessage ?? null : payload.queuedMessage,
    });
    return { ok: true };
  });
  mocks.upload.mockResolvedValue({
    ok: true, json: async () => ({ attachments: [{ path: '/uploads/notes.txt', name: 'notes.txt' }] }),
  });
});

function consumeQueue(scope = 'a') {
  const draft = mocks.drafts.get(scope);
  if (draft) mocks.drafts.set(scope, { ...draft, queuedMessage: null });
}

function fixture(steerMessage: SteerChatMessage = vi.fn(async (scope) => consumeQueue(scope))) {
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

async function queue(view: ReturnType<typeof fixture>, content = 'Focus on tests', files: File[] = []) {
  act(() => { view.result.current.setInput(content); view.result.current.setAttachedFiles(files); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  return readQueuedMessage('a')!;
}

test('Send queues first; only the queued receipt is appended, without touching the next draft', async () => {
  let accept!: () => void;
  const request = new Promise<void>((resolve) => { accept = resolve; });
  const steer = vi.fn(() => request);
  const view = fixture(steer);
  const saved = await queue(view);
  expect(saved.id).toBeTruthy();
  expect(view.result.current.input).toBe('');
  expect(steer).not.toHaveBeenCalled();

  const files = [new File(['new'], 'new.txt')];
  act(() => { view.result.current.setInput('A different new draft'); view.result.current.setAttachedFiles(files); });
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.handleSteerQueued(); });
  expect(view.result.current.isSteering).toBe(true);
  expect(steer).toHaveBeenCalledWith('a', 'Focus on tests', [], saved);
  consumeQueue();
  await act(async () => {
    await hydrateChatDrafts();
    await view.result.current.handleSteerQueued();
    view.result.current.editQueuedDraft();
    view.result.current.deleteQueuedDraft();
    await view.result.current.handleSubmit({ preventDefault() {} } as never);
  });
  expect(steer).toHaveBeenCalledTimes(1);
  expect(view.result.current.queuedDraft?.content).toBe('Focus on tests');
  await act(async () => { accept(); await submission; });
  expect(view.result.current.queuedDraft).toBeNull();
  expect(view.result.current.input).toBe('A different new draft');
  expect(readDraftText('a')).toBe('A different new draft');
  expect(view.result.current.attachedFiles).toBe(files);
  expect(readQueuedMessage('a')).toBeNull();
  expect(view.result.current.isSteering).toBe(false);
  expect(view.send).not.toHaveBeenCalled();
  expect(view.echo).not.toHaveBeenCalled();
  expect(view.processing).not.toHaveBeenCalled();
  expect(mocks.save.mock.calls.filter(([, payload]) => !payload.preserveQueuedMessage)).toHaveLength(1);
});

test('a refusal retains the queued message and the independent textarea text/files', async () => {
  const view = fixture(vi.fn(async () => { throw new Error('The turn ended'); }));
  const saved = await queue(view);
  const files = [new File(['notes'], 'notes.txt', { type: 'text/plain' })];
  act(() => { view.result.current.setInput('Keep this draft'); view.result.current.setAttachedFiles(files); });
  await act(async () => { await view.result.current.handleSteerQueued(); });
  expect(view.result.current.input).toBe('Keep this draft');
  expect(view.result.current.attachedFiles).toBe(files);
  expect(view.result.current.steerError).toBe('The turn ended');
  expect(readQueuedMessage('a')).toEqual(saved);
  expect(view.result.current.queuedDraft?.id).toBe(saved.id);
  expect(view.send).not.toHaveBeenCalled();
  expect(view.echo).not.toHaveBeenCalled();
});

test('promotion reuses the original queue uploads and captured execution options', async () => {
  const view = fixture();
  const saved = await queue(view, 'Use these notes', [new File(['old'], 'notes.txt')]);
  await act(async () => { await view.result.current.handleSteerQueued(); });
  expect(view.steerMessage).toHaveBeenCalledWith('a', saved.content, saved.attachments, saved);
  expect(saved.options).toMatchObject({ model: 'test-model', effort: 'high', permissionMode: 'default' });
  expect(mocks.upload).toHaveBeenCalledTimes(1);
  expect(readQueuedMessage('a')).toBeNull();
});

test('a restored attachment-only queue is appendable without the original browser File', async () => {
  writeQueuedMessage('a', { id: 'restored', content: '', images: [{ path: '/uploads/notes.txt', name: 'notes.txt' }] });
  const view = fixture();
  expect(view.result.current.queuedDraft?.attachments).toEqual([]);
  await act(async () => { await view.result.current.handleSteerQueued(); });
  expect(view.steerMessage).toHaveBeenCalledWith('a', '', [{ path: '/uploads/notes.txt', name: 'notes.txt' }], expect.objectContaining({ id: 'restored' }));
  expect(mocks.upload).not.toHaveBeenCalled();
});

test('a session switch during acknowledgement preserves new drafts and the destination queue', async () => {
  let accept!: () => void;
  const request = new Promise<void>((resolve) => { accept = resolve; });
  const view = fixture(() => request);
  await queue(view, 'Correction for A');
  act(() => {
    view.result.current.setInput('New A draft');
    writeDraftText('b', 'Draft for B');
    writeQueuedMessage('b', { id: 'b-queue', content: 'Queue for B' });
  });
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.handleSteerQueued(); });
  view.rerender({ sessionId: 'b', provider: 'codex', busy: true });
  consumeQueue();
  await act(async () => { accept(); await submission; });
  expect(view.result.current.input).toBe('Draft for B');
  expect(readDraftText('b')).toBe('Draft for B');
  expect(readDraftText('a')).toBe('New A draft');
  expect(view.result.current.queuedDraft?.id).toBe('b-queue');
});

test('acceptance cannot delete an identical replacement queued on another device', async () => {
  let accept!: () => void;
  const request = new Promise<void>((resolve) => { accept = resolve; });
  const view = fixture(() => request);
  const saved = await queue(view);
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.handleSteerQueued(); });
  act(() => writeQueuedMessage('a', { ...saved, id: 'replacement' }));
  await act(async () => { accept(); await submission; });
  expect(readQueuedMessage('a')?.id).toBe('replacement');
  expect(view.result.current.queuedDraft?.id).toBe('replacement');
});

test('pending queue persistence must finish before promotion', async () => {
  let persisted!: () => void;
  const deferred = new Promise<void>((resolve) => { persisted = resolve; });
  mocks.save.mockImplementationOnce(async (scope, payload) => {
    await deferred;
    mocks.drafts.set(scope, { scope, text: payload.text, queuedMessage: payload.queuedMessage });
    return { ok: true };
  });
  const view = fixture();
  await queue(view);
  let submission!: Promise<void>;
  await act(async () => { submission = view.result.current.handleSteerQueued(); });
  expect(view.steerMessage).not.toHaveBeenCalled();
  await act(async () => { persisted(); await submission; });
  expect(view.steerMessage).toHaveBeenCalledOnce();
});

test('ambiguous native acknowledgement holds the queue and prevents repeat clicks', async () => {
  const steer = vi.fn(async () => {
    const draft = mocks.drafts.get('a')!;
    mocks.drafts.set('a', { ...draft, queuedMessage: { ...draft.queuedMessage!, steerHold: 'unconfirmed' } });
    throw Object.assign(new Error('Check delivery'), { queueHeld: true });
  });
  const view = fixture(steer);
  await queue(view);
  await act(async () => { await view.result.current.handleSteerQueued(); });
  expect(view.result.current.queuedDraft?.steerHold).toBe('unconfirmed');
  await act(async () => { await view.result.current.handleSteerQueued(); });
  expect(steer).toHaveBeenCalledOnce();
  expect(mocks.save.mock.calls.filter(([, payload]) => !payload.preserveQueuedMessage)).toHaveLength(1);
  act(() => view.result.current.editQueuedDraft());
  expect(view.result.current.input).toBe('Focus on tests');
  expect(readQueuedMessage('a')).toBeNull();
});

test('a failed upload keeps unsent input and cannot produce a partial queued append', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.upload.mockRejectedValue(new Error('Upload failed'));
  const view = fixture();
  await queue(view, 'See attachment', [new File(['file'], 'notes.txt')]);
  await act(async () => { await view.result.current.handleSteerQueued(); });
  expect(view.steerMessage).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('See attachment');
  expect(view.result.current.attachedFiles).toHaveLength(1);
  expect(readQueuedMessage('a')).toBeNull();
  errorLog.mockRestore();
});

test('no queue, idle or non-Codex sessions cannot be steered', async () => {
  const view = fixture();
  act(() => view.result.current.setInput('Not sent yet'));
  await act(async () => { await view.result.current.handleSteerQueued(); });
  await queue(view);
  view.rerender({ sessionId: 'a', provider: 'codex', busy: false });
  await act(async () => { await view.result.current.handleSteerQueued(); });
  view.rerender({ sessionId: 'a', provider: 'claude', busy: true });
  await act(async () => { await view.result.current.handleSteerQueued(); });
  expect(view.steerMessage).not.toHaveBeenCalled();
});

test('restoring or hydrating consumed/remote queues never writes them back to the server', async () => {
  writeQueuedMessage('a', { id: 'old', content: 'Already queued' });
  await flushChatDraft('a');
  mocks.save.mockClear();
  const view = fixture();
  expect(mocks.save).not.toHaveBeenCalled();
  consumeQueue();
  await act(async () => { await hydrateChatDrafts(); });
  expect(view.result.current.queuedDraft).toBeNull();
  expect(mocks.save).not.toHaveBeenCalled();
  mocks.drafts.set('a', { scope: 'a', text: '', queuedMessage: { id: 'remote', content: 'From phone' } });
  await act(async () => { await hydrateChatDrafts(); });
  expect(view.result.current.queuedDraft?.id).toBe('remote');
  expect(mocks.save).not.toHaveBeenCalled();
});
