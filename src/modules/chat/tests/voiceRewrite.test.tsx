import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { useVoiceRewrite } from '@/modules/chat/hooks/useVoiceRewrite';
import { selectVoiceRewriteHistory } from '@/modules/chat/utils/voiceRewriteHistory';
import { VoiceRewriteControl } from '@/modules/chat/composer/VoiceRewriteControl';
import type { ChatMessage } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { voice: { codeyRewrite: vi.fn() } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const input = { prefix: 'Keep this typed text. ', transcript: '呃，请检查，不要重启。', draft: 'Keep this typed text. 呃，请检查，不要重启。' };
const improved = '请检查，不要重启。';
const answer = (text = improved, ambiguities: string[] = []) => new Response(JSON.stringify({ text, ambiguities }));
const message = (type: string, content: string, extra = {}): ChatMessage => ({ type, content, timestamp: 0, ...extra });

function fixture(initial: { scope: string; enabled: boolean; useHistory: boolean; configured?: boolean } =
  { scope: 'session-a', enabled: true, useHistory: true }) {
  return renderHook(({ scope, enabled, useHistory, configured = true }) => {
    // A disposable draft models the composer's functional compare-and-set.
    const [draft, setDraft] = useState(input.draft);
    const rewrite = useVoiceRewrite({
      contextKey: scope, draft, enabled, configured, useHistory, language: 'auto',
      replaceDraft: (expected, next) => setDraft((current) => current === expected ? next : current),
    });
    return { ...rewrite, draft, setDraft };
  }, { initialProps: initial });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.voice.codeyRewrite).mockImplementation(async () => answer());
});
afterEach(() => { vi.useRealTimers(); });

test('history includes at most three user turns and excludes reasoning, tools, streaming and credentials', () => {
  const result = selectVoiceRewriteHistory([
    message('user', 'too old'), message('assistant', 'old reply'),
    message('user', 'one'), message('assistant', 'one reply'),
    message('assistant', 'private reasoning', { isThinking: true }),
    message('user', 'two'), message('assistant', 'terminal secret', { isToolUse: true }),
    message('assistant', 'subagent secret', { isSubagentContainer: true }),
    message('assistant', 'still streaming', { isStreaming: true }),
    message('assistant', 'two reply'),
    message('user', 'three api_key=fake-secret-value ```sh\nprivate code\n```'),
    message('assistant', 'three reply'),
  ]);
  expect(result).toHaveLength(6);
  expect(result[0].content).toBe('one');
  expect(JSON.stringify(result)).not.toMatch(/too old|private reasoning|terminal secret|subagent secret|still streaming|fake-secret-value|private code/);
  expect(JSON.stringify(result)).toContain('[credential omitted]');
  const large = selectVoiceRewriteHistory(Array.from({ length: 12 }, (_, index) => message(index % 2 ? 'assistant' : 'user', '中文😀'.repeat(3000))));
  expect(large.reduce((bytes, item) => bytes + new TextEncoder().encode(item.content).length, 0)).toBeLessThanOrEqual(3000);
  expect(large.every((item) => !item.content.includes('\uFFFD'))).toBe(true);
});

test('manual rewrite only replaces the voice fragment and supports repeated local undo/restore without another API call', async () => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, [message('user', 'current history')]));
  expect(api.voice.codeyRewrite).not.toHaveBeenCalled();
  expect(hook.result.current.canRewrite).toBe(true);
  expect(hook.result.current.hasPreviousRewrite).toBe(false);
  await act(async () => hook.result.current.rewrite());
  expect(hook.result.current.draft).toBe(input.prefix + improved);
  expect(hook.result.current.canUndo).toBe(true);
  expect(vi.mocked(api.voice.codeyRewrite).mock.calls[0][0]).toEqual({
    transcript: input.transcript, language: 'auto', history: [{ role: 'user', content: 'current history' }],
  });
  expect(hook.result.current.hasPreviousRewrite).toBe(true);
  expect(hook.result.current.canRestore).toBe(false);
  expect(hook.result.current.needsAttention).toBe(false);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    act(() => hook.result.current.undo());
    expect(hook.result.current.draft).toBe(input.draft);
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.hasPreviousRewrite).toBe(true);
    expect(hook.result.current.canRestore).toBe(true);
    act(() => hook.result.current.restore());
    expect(hook.result.current.draft).toBe(input.prefix + improved);
    expect(hook.result.current.canUndo).toBe(true);
    expect(hook.result.current.canRestore).toBe(false);
    expect(hook.result.current.notice).toBe('restored');
  }
  expect(api.voice.codeyRewrite).toHaveBeenCalledOnce();
});

test.each([true, false])('regeneration from the original draft (%s) uses the original transcript and replaces the cached result', async (undoFirst) => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  if (undoFirst) act(() => hook.result.current.undo());
  const newest = '请先检查，但不要重启。';
  vi.mocked(api.voice.codeyRewrite).mockResolvedValueOnce(answer(newest));
  await act(async () => hook.result.current.rewrite());
  expect(vi.mocked(api.voice.codeyRewrite).mock.calls[1][0].transcript).toBe(input.transcript);
  expect(hook.result.current.draft).toBe(input.prefix + newest);
  act(() => hook.result.current.undo());
  expect(hook.result.current.draft).toBe(input.draft);
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe(input.prefix + newest);
  expect(api.voice.codeyRewrite).toHaveBeenCalledTimes(2);
});

test('restoring a saved result does not require a configured AI service', async () => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  act(() => hook.result.current.undo());
  hook.rerender({ scope: 'session-a', enabled: true, useHistory: true, configured: false });
  expect(hook.result.current.canRewrite).toBe(false);
  expect(hook.result.current.canRestore).toBe(true);
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe(input.prefix + improved);
  expect(hook.result.current.canUndo).toBe(true);
  expect(api.voice.codeyRewrite).toHaveBeenCalledOnce();
});

test('an unchanged rewrite has a cached result but offers no redundant undo or restore', async () => {
  vi.mocked(api.voice.codeyRewrite).mockResolvedValueOnce(answer(input.transcript));
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  expect(hook.result.current.hasPreviousRewrite).toBe(true);
  expect(hook.result.current.canUndo).toBe(false);
  expect(hook.result.current.canRestore).toBe(false);
  expect(hook.result.current.canRewrite).toBe(true);
  expect(hook.result.current.notice).toBe('unchanged');
});

test('history can be excluded without disabling rewrite and no draft prefix is sent to the model', async () => {
  const hook = fixture({ scope: 'session-a', enabled: true, useHistory: false });
  act(() => hook.result.current.remember(input, [message('assistant', 'private dialogue')]));
  await act(async () => hook.result.current.rewrite());
  const payload = vi.mocked(api.voice.codeyRewrite).mock.calls[0][0];
  expect(payload.history).toEqual([]);
  expect(JSON.stringify(payload)).not.toContain('Keep this typed text.');
});

test('duplicate clicks make one request, cancellation aborts it and ignores a late successful result', async () => {
  let finish: (value: Response) => void = () => {};
  vi.mocked(api.voice.codeyRewrite).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  act(() => { void hook.result.current.rewrite(); void hook.result.current.rewrite(); });
  expect(api.voice.codeyRewrite).toHaveBeenCalledOnce();
  expect(hook.result.current.busy).toBe(true);
  const signal = vi.mocked(api.voice.codeyRewrite).mock.calls[0][1];
  act(() => hook.result.current.cancel());
  expect(signal.aborted).toBe(true);
  await act(async () => finish(answer()));
  expect(hook.result.current.draft).toBe(input.draft);
  expect(hook.result.current.canUndo).toBe(false);
});

test.each(['edit', 'session', 'disabled', 'unmount'] as const)('%s cancels an in-flight rewrite and prevents stale text insertion', async (action) => {
  let finish: (value: Response) => void = () => {};
  vi.mocked(api.voice.codeyRewrite).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  act(() => { void hook.result.current.rewrite(); });
  const signal = vi.mocked(api.voice.codeyRewrite).mock.calls[0][1];
  if (action === 'edit') act(() => hook.result.current.setDraft('New user edit'));
  else if (action === 'unmount') hook.unmount();
  else hook.rerender({ scope: action === 'session' ? 'session-b' : 'session-a', enabled: action !== 'disabled', useHistory: true });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(answer()));
  if (action !== 'unmount') expect(hook.result.current.draft).toBe(action === 'edit' ? 'New user edit' : input.draft);
});

test('undo cannot overwrite edits made after the rewrite', async () => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  act(() => hook.result.current.setDraft('User edited the rewritten text'));
  expect(hook.result.current.canUndo).toBe(false);
  act(() => hook.result.current.undo());
  expect(hook.result.current.draft).toBe('User edited the rewritten text');
  expect(hook.result.current.originalText).toBe(input.transcript);
});

test('restore cannot overwrite edits made after undo', async () => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  act(() => hook.result.current.undo());
  act(() => hook.result.current.setDraft('New edits to the original text'));
  expect(hook.result.current.canRestore).toBe(false);
  expect(hook.result.current.canRewrite).toBe(false);
  expect(hook.result.current.notice).toBe('draftChanged');
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe('New edits to the original text');
  expect(api.voice.codeyRewrite).toHaveBeenCalledOnce();
});

test.each(['clear', 'recording', 'session', 'disabled'] as const)('%s discards the previous rewrite and prevents stale restore callbacks', async (action) => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  act(() => hook.result.current.undo());
  const restore = hook.result.current.restore;
  if (action === 'clear') act(() => hook.result.current.clear());
  else if (action === 'recording') act(() => hook.result.current.remember(input, []));
  else {
    hook.rerender({ scope: action === 'session' ? 'session-b' : 'session-a', enabled: action !== 'disabled', useHistory: true });
    hook.rerender({ scope: 'session-a', enabled: true, useHistory: true });
  }
  expect(hook.result.current.hasPreviousRewrite).toBe(false);
  expect(hook.result.current.canRestore).toBe(false);
  act(() => restore());
  expect(hook.result.current.draft).toBe(input.draft);
  expect(api.voice.codeyRewrite).toHaveBeenCalledOnce();
});

test('ambiguous candidates require explicit review and applying one is still undoable', async () => {
  vi.mocked(api.voice.codeyRewrite).mockImplementation(async () => answer(improved, ['检查']));
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  expect(hook.result.current.draft).toBe(input.draft);
  expect(hook.result.current.candidate?.text).toBe(improved);
  expect(hook.result.current.needsAttention).toBe(true);
  expect(hook.result.current.hasPreviousRewrite).toBe(false);
  expect(hook.result.current.canRestore).toBe(false);
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe(input.draft);
  act(() => hook.result.current.applyCandidate());
  expect(hook.result.current.draft).toBe(input.prefix + improved);
  expect(hook.result.current.needsAttention).toBe(false);
  act(() => hook.result.current.undo());
  expect(hook.result.current.draft).toBe(input.draft);
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe(input.prefix + improved);
  expect(api.voice.codeyRewrite).toHaveBeenCalledOnce();
});

test.each([true, false])('an ambiguous regeneration replaces the cached result only after explicit approval (%s)', async (approve) => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  act(() => hook.result.current.undo());
  const suggestion = '请先检查，但不要重启。';
  vi.mocked(api.voice.codeyRewrite).mockResolvedValueOnce(answer(suggestion, ['检查']));
  await act(async () => hook.result.current.rewrite());
  expect(hook.result.current.draft).toBe(input.draft);
  expect(hook.result.current.candidate?.text).toBe(suggestion);
  if (approve) {
    act(() => hook.result.current.applyCandidate());
    act(() => hook.result.current.undo());
  }
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe(input.prefix + (approve ? suggestion : improved));
  expect(hook.result.current.candidate).toBeUndefined();
  expect(api.voice.codeyRewrite).toHaveBeenCalledTimes(2);
});

test.each(['server error', 'invalid output'])('regeneration with %s keeps the previous result available for local restore', async (failure) => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  act(() => hook.result.current.undo());
  vi.mocked(api.voice.codeyRewrite).mockResolvedValueOnce(failure === 'server error'
    ? new Response(JSON.stringify({ code: 'VOICE_REWRITE_UNAVAILABLE' }), { status: 502 }) : answer(''));
  await act(async () => hook.result.current.rewrite());
  expect(hook.result.current.draft).toBe(input.draft);
  expect(hook.result.current.canRestore).toBe(true);
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe(input.prefix + improved);
  expect(api.voice.codeyRewrite).toHaveBeenCalledTimes(2);
});

test.each(['cancel', 'timeout'])('%s preserves the last rewrite, blocks restore while busy and ignores late regeneration', async (action) => {
  vi.useFakeTimers();
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  await act(async () => hook.result.current.rewrite());
  act(() => hook.result.current.undo());
  let finish: (value: Response) => void = () => {};
  vi.mocked(api.voice.codeyRewrite).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => { void hook.result.current.rewrite(); });
  expect(hook.result.current.busy).toBe(true);
  expect(hook.result.current.canRestore).toBe(false);
  act(() => hook.result.current.restore());
  expect(hook.result.current.draft).toBe(input.draft);
  if (action === 'cancel') act(() => hook.result.current.cancel());
  else await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(vi.mocked(api.voice.codeyRewrite).mock.calls[1][1].aborted).toBe(true);
  expect(hook.result.current.canRestore).toBe(true);
  act(() => hook.result.current.restore());
  await act(async () => finish(answer('Late result must not replace the restored draft.')));
  expect(hook.result.current.draft).toBe(input.prefix + improved);
  expect(api.voice.codeyRewrite).toHaveBeenCalledTimes(2);
});

test('failure or invalid model output keeps the original draft and does not automatically retry', async () => {
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  vi.mocked(api.voice.codeyRewrite).mockImplementation(async () => new Response(JSON.stringify({ code: 'VOICE_REWRITE_TIMEOUT' }), { status: 504 }));
  await act(async () => hook.result.current.rewrite());
  expect(hook.result.current.notice).toBe('VOICE_REWRITE_TIMEOUT');
  expect(hook.result.current.needsAttention).toBe(true);
  expect(hook.result.current.draft).toBe(input.draft);
  expect(api.voice.codeyRewrite).toHaveBeenCalledOnce();
  vi.mocked(api.voice.codeyRewrite).mockImplementation(async () => answer(''));
  await act(async () => hook.result.current.rewrite());
  expect(hook.result.current.draft).toBe(input.draft);
});

test('the compact rewrite/cancel/undo/restore buttons never submit the surrounding composer', () => {
  const rewrite = vi.fn(), cancel = vi.fn(), undo = vi.fn(), restore = vi.fn(), send = vi.fn();
  const renderControl = (busy: boolean, canUndo: boolean, canRestore = false) => (
    <form onSubmit={send}>
      <VoiceRewriteControl busy={busy} canRewrite={!busy} configured canUndo={canUndo}
        canRestore={canRestore} hasPreviousRewrite={canUndo || canRestore}
        onRewrite={rewrite} onCancel={cancel} onUndo={undo} onRestore={restore} />
    </form>
  );
  const ui = render(renderControl(false, false));
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.action' }));
  expect(rewrite).toHaveBeenCalledOnce();
  ui.rerender(renderControl(true, false));
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.cancel' }));
  expect(cancel).toHaveBeenCalledOnce();
  ui.rerender(renderControl(false, true));
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.undo' }));
  expect(undo).toHaveBeenCalledOnce();
  ui.rerender(renderControl(false, false, true));
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.restore' }));
  expect(restore).toHaveBeenCalledOnce();
  expect(rewrite).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});

test('a cached rewrite opens a keyboard-accessible choice instead of generating and each menu item has an explicit action', async () => {
  const rewrite = vi.fn(), restore = vi.fn(), send = vi.fn();
  render(
    <form onSubmit={send}>
      <VoiceRewriteControl busy={false} canRewrite canUndo={false} canRestore hasPreviousRewrite configured
        onRewrite={rewrite} onCancel={vi.fn()} onUndo={vi.fn()} onRestore={restore} />
    </form>,
  );
  const trigger = screen.getByRole('button', { name: 'voice.rewrite.action' });
  fireEvent.click(trigger);
  expect(screen.getByRole('menu', { name: 'voice.rewrite.options' })).toBeTruthy();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(rewrite).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  const restoreItem = screen.getByRole('menuitem', { name: /^voice\.rewrite\.restore / });
  const regenerateItem = screen.getByRole('menuitem', { name: /^voice\.rewrite\.regenerate / });
  await waitFor(() => expect(document.activeElement).toBe(restoreItem));
  fireEvent.keyDown(restoreItem, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(regenerateItem);
  fireEvent.keyDown(regenerateItem, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: /^voice\.rewrite\.restore / }));
  expect(restore).toHaveBeenCalledOnce();
  expect(rewrite).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: /^voice\.rewrite\.regenerate / }));
  expect(rewrite).toHaveBeenCalledOnce();
  expect(restore).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test('the menu permits local restore without AI configuration and closes when the draft becomes unsafe', () => {
  const rewrite = vi.fn(), restore = vi.fn();
  const renderControl = (canRestore: boolean) => (
    <VoiceRewriteControl busy={false} canRewrite={false} canUndo={false} canRestore={canRestore} hasPreviousRewrite configured={false}
      onRewrite={rewrite} onCancel={vi.fn()} onUndo={vi.fn()} onRestore={restore} />
  );
  const ui = render(renderControl(true));
  const trigger = screen.getByRole('button', { name: 'voice.rewrite.action' });
  expect(trigger.hasAttribute('disabled')).toBe(false);
  fireEvent.click(trigger);
  const regenerateItem = screen.getByRole('menuitem', { name: /^voice\.rewrite\.regenerate / });
  expect(regenerateItem.hasAttribute('disabled')).toBe(true);
  fireEvent.click(regenerateItem);
  expect(rewrite).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: /^voice\.rewrite\.restore / }));
  expect(restore).toHaveBeenCalledOnce();
  fireEvent.click(trigger);
  ui.rerender(renderControl(false));
  expect(trigger.hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('menu')).toBeNull();
  ui.rerender(renderControl(true));
  expect(screen.queryByRole('menu')).toBeNull();
});

test('a rewrite already displayed disables restore in the menu but still offers explicit regeneration', () => {
  render(<VoiceRewriteControl busy={false} canRewrite canUndo canRestore={false} hasPreviousRewrite configured
    onRewrite={vi.fn()} onCancel={vi.fn()} onUndo={vi.fn()} onRestore={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.action' }));
  expect(screen.getByRole('menuitem', { name: /^voice\.rewrite\.restore / }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('menuitem', { name: /^voice\.rewrite\.regenerate / }).hasAttribute('disabled')).toBe(false);
});

test.each([false, true])('edited voice details stay hidden but remain readable without allowing replacement (previous rewrite: %s)', async (hasPreviousRewrite) => {
  const rewrite = vi.fn(), restore = vi.fn(), send = vi.fn();
  const ui = render(
    <form onSubmit={send}>
      <VoiceRewriteControl busy={false} canRewrite={false} canUndo={false} canRestore={false}
        hasPreviousRewrite={hasPreviousRewrite} configured={false} originalText={input.transcript} notice="draftChanged"
        onRewrite={rewrite} onCancel={vi.fn()} onUndo={vi.fn()} onRestore={restore} />
    </form>,
  );
  const trigger = screen.getByRole('button', { name: 'voice.rewrite.action' });
  expect(trigger.hasAttribute('disabled')).toBe(false);
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('voice.rewrite.original')).toBeNull();
  expect(screen.queryByText(input.transcript)).toBeNull();
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('voice.rewrite.draftChanged');
  expect(status.classList.contains('sr-only')).toBe(true);
  expect(trigger.getAttribute('aria-describedby')).toBe(status.id);

  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'voice.rewrite.options' });
  expect(ui.container.contains(dialog)).toBe(false);
  expect(dialog.classList.contains('fixed')).toBe(true);
  expect(within(dialog).getByText('voice.rewrite.draftChanged')).toBeTruthy();
  const original = within(dialog).getByText('voice.rewrite.original');
  const disclosure = original.closest('details')!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(original);
  expect(disclosure.open).toBe(true);
  expect(within(disclosure).getByText(input.transcript)).toBeTruthy();
  const action = within(dialog).getByRole('button', { name: hasPreviousRewrite
    ? /^voice\.rewrite\.regenerate / : /^voice\.rewrite\.action / });
  expect(action.hasAttribute('disabled')).toBe(true);
  fireEvent.click(action);
  if (hasPreviousRewrite) {
    const restoreItem = within(dialog).getByRole('button', { name: /^voice\.rewrite\.restore / });
    expect(restoreItem.hasAttribute('disabled')).toBe(true);
    fireEvent.click(restoreItem);
  }
  expect(rewrite).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  const close = within(dialog).getByRole('button', { name: 'voice.rewrite.close' });
  await waitFor(() => expect(document.activeElement).toBe(close));
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(screen.getByText('voice.rewrite.original').closest('details')!.open).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a fresh voice fragment can be inspected without calling AI; rewriting remains an explicit action', () => {
  const rewrite = vi.fn(), send = vi.fn();
  render(
    <form onSubmit={send}>
      <VoiceRewriteControl busy={false} canRewrite canUndo={false} canRestore={false} hasPreviousRewrite={false}
        configured originalText={input.transcript}
        onRewrite={rewrite} onCancel={vi.fn()} onUndo={vi.fn()} onRestore={vi.fn()} />
    </form>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.action' }));
  expect(rewrite).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('voice.rewrite.original')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: /^voice\.rewrite\.restore / })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: /^voice\.rewrite\.action / }));
  expect(rewrite).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test.each([true, false])('review suggestions use a compact attention marker and never bypass draft protection (can apply: %s)', (canApply) => {
  const apply = vi.fn(), send = vi.fn();
  const ui = render(
    <form onSubmit={send}>
      <VoiceRewriteControl busy={false} canRewrite={canApply} canUndo={false} canRestore={false}
        hasPreviousRewrite={false} configured originalText={input.transcript}
        notice={canApply ? 'needsReview' : 'draftChanged'} needsAttention
        candidate={{ text: improved, ambiguities: ['检查'] }} canApply={canApply} onApply={apply}
        onRewrite={vi.fn()} onCancel={vi.fn()} onUndo={vi.fn()} onRestore={vi.fn()} />
    </form>,
  );
  expect(ui.container.querySelector('[data-slot="voice-rewrite-attention"]')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'voice.rewrite.suggestion' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.action' }));
  const dialog = screen.getByRole('dialog');
  const suggestion = within(dialog).getByRole('textbox', { name: 'voice.rewrite.suggestion' }) as HTMLTextAreaElement;
  expect(suggestion.value).toBe(improved);
  expect(suggestion.readOnly).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  if (canApply) {
    fireEvent.click(within(dialog).getByRole('button', { name: 'voice.rewrite.apply' }));
    expect(apply).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  } else {
    expect(within(dialog).queryByRole('button', { name: 'voice.rewrite.apply' })).toBeNull();
    expect(within(dialog).getByText('voice.rewrite.copySuggestion')).toBeTruthy();
  }
  expect(send).not.toHaveBeenCalled();
});

test('a failed rewrite exposes its error on demand without expanding the input or retrying automatically', () => {
  const rewrite = vi.fn();
  const ui = render(<VoiceRewriteControl busy={false} canRewrite canUndo={false} canRestore={false}
    hasPreviousRewrite={false} configured originalText={input.transcript}
    notice="VOICE_REWRITE_TIMEOUT" needsAttention
    onRewrite={rewrite} onCancel={vi.fn()} onUndo={vi.fn()} onRestore={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(ui.container.querySelector('[data-slot="voice-rewrite-attention"]')).toBeTruthy();
  expect(screen.getByRole('status').classList.contains('sr-only')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'voice.rewrite.action' }));
  expect(within(screen.getByRole('dialog')).getByText('voice.rewrite.VOICE_REWRITE_TIMEOUT')).toBeTruthy();
  expect(rewrite).not.toHaveBeenCalled();
});

test('a stalled browser request times out, aborts and leaves the original draft recoverable', async () => {
  vi.useFakeTimers();
  vi.mocked(api.voice.codeyRewrite).mockImplementation(() => new Promise(() => {}));
  const hook = fixture();
  act(() => hook.result.current.remember(input, []));
  act(() => { void hook.result.current.rewrite(); });
  const signal = vi.mocked(api.voice.codeyRewrite).mock.calls[0][1];
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(signal.aborted).toBe(true);
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.notice).toBe('VOICE_REWRITE_TIMEOUT');
  expect(hook.result.current.draft).toBe(input.draft);
});
