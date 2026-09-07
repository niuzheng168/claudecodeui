import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import {
  hasHydratedUserPreferences, hydrateUserPreferences, resetUserPreferences, writeUserPreference,
} from '@/shared/userSettings';
import { useInlineCompletion } from '@/modules/chat/hooks/useInlineCompletion';
import type { ChatMessage, ComposerCompletionConfig, ComposerCompletionRequest } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: {
  composer: { config: vi.fn(), complete: vi.fn() },
  user: { preferences: vi.fn(), savePreferences: vi.fn() },
} }));
const config: ComposerCompletionConfig = {
  configured: true, userId: 'test-owner-a', promptVersion: 'composer-completion-v1',
  limits: { prefixBytes: 4096, historyMessages: 6, historyBytes: 3000, historyMessageBytes: 1000,
    suffixCharacters: 80, debounceMs: 500, minIntervalMs: 2000 },
};
const response = (body: ComposerCompletionRequest, suffix = ' the main trade-offs.') =>
  new Response(JSON.stringify({ ...body, suffix, promptVersion: config.promptVersion }));
const areas: HTMLTextAreaElement[] = [];
const history: ChatMessage[] = [
  { type: 'user', content: 'Consider the trade-offs.', timestamp: 0 },
  { type: 'assistant', content: 'Discuss the design options.', timestamp: 1 },
];

async function fixture(
  initial = { scope: 'session-a', blocked: false, active: true, history, refuseEdit: false },
  expectedConfigured = true,
) {
  const textarea = document.createElement('textarea');
  areas.push(textarea);
  document.body.append(textarea); textarea.focus();
  const textareaRef = { current: textarea };
  const hook = renderHook(({ scope, blocked, active, history: messages, refuseEdit }) => {
    // Real user edits and the parent's guarded replacements share one controlled draft.
    const [draft, setDraft] = useState('');
    const completion = useInlineCompletion({
      managed: true, active, blocked, contextKey: scope, draft, history: messages, textareaRef,
      replaceDraft: (expected, next) => {
        if (!refuseEdit) {
          setDraft((current) => current === expected ? next : current);
          textarea.value = next;
          textarea.setSelectionRange(next.length, next.length);
        }
      },
    });
    return { ...completion, draft, setDraft };
  }, { initialProps: initial });
  await waitFor(() => expect(hook.result.current.configured).toBe(expectedConfigured));
  vi.useFakeTimers();
  const type = (value: string, caret = value.length) => act(() => {
    textarea.value = value; textarea.setSelectionRange(caret, caret); textarea.focus();
    hook.result.current.setDraft(value);
    hook.result.current.receiveUserInput(value);
  });
  const programmatic = (value: string) => act(() => {
    textarea.value = value; textarea.setSelectionRange(value.length, value.length);
    hook.result.current.setDraft(value);
  });
  return { hook, textarea, type, programmatic };
}

const tick = (ms = 500) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const keyboard = (key: string, overrides = {}) => ({
  key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, defaultPrevented: false,
  nativeEvent: { isComposing: false }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
}) as unknown as KeyboardEvent<HTMLTextAreaElement>;

beforeEach(async () => {
  vi.useRealTimers(); vi.clearAllMocks(); resetUserPreferences();
  vi.mocked(api.user.preferences).mockResolvedValue(new Response(JSON.stringify({
    preferences: { composerPreferences: { completionEnabled: true, useHistory: true } },
  })));
  vi.mocked(api.user.savePreferences).mockResolvedValue(new Response('{}'));
  vi.mocked(api.composer.config).mockImplementation(async () => new Response(JSON.stringify(config)));
  vi.mocked(api.composer.complete).mockImplementation(async (body) => response(body));
  await hydrateUserPreferences();
});
afterEach(() => {
  cleanup();
  for (const textarea of areas.splice(0)) textarea.remove();
  vi.useRealTimers(); resetUserPreferences();
});

test('only a debounced user edit requests a proposal; the proposal is never the draft', async () => {
  const f = await fixture();
  expect(api.composer.complete).not.toHaveBeenCalled();
  f.type('Please explain'); await tick(499);
  expect(api.composer.complete).not.toHaveBeenCalled();
  await tick(1);
  expect(f.hook.result.current.candidate?.suffix).toBe(' the main trade-offs.');
  expect(f.hook.result.current.draft).toBe('Please explain');
  expect(vi.mocked(api.composer.complete).mock.calls[0][0].history).toHaveLength(2);
});

test('Tab accepts once, confirms the actual draft edit and offers a guarded local undo', async () => {
  const f = await fixture();
  f.type('Please explain'); await tick();
  const event = keyboard('Tab');
  act(() => f.hook.result.current.onKeyDown(event));
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(f.hook.result.current.draft).toBe('Please explain the main trade-offs.');
  expect(f.hook.result.current.notice).toBe('applied');
  expect(f.hook.result.current.canUndo).toBe(true);
  expect(f.hook.result.current.candidate).toBeNull();
  await tick(5000);
  expect(api.composer.complete).toHaveBeenCalledOnce();
  act(() => f.hook.result.current.undo());
  expect(f.hook.result.current.draft).toBe('Please explain');
  expect(f.hook.result.current.notice).toBe('undone');
});

test('a rejected compare-and-set is not reported as a successful insertion', async () => {
  const f = await fixture({ scope: 'a', blocked: false, active: true, history, refuseEdit: true });
  f.type('Please explain'); await tick();
  act(() => f.hook.result.current.accept());
  expect(f.hook.result.current.draft).toBe('Please explain');
  expect(f.hook.result.current.canUndo).toBe(false);
  expect(f.hook.result.current.notice).toBeNull();
});

test('typing a matching prefix consumes the candidate without another model request', async () => {
  const f = await fixture();
  f.type('Please explain'); await tick();
  f.type('Please explain the');
  expect(f.hook.result.current.candidate?.suffix).toBe(' main trade-offs.');
  await tick(3000);
  expect(api.composer.complete).toHaveBeenCalledOnce();
  act(() => f.hook.result.current.accept());
  expect(f.hook.result.current.draft).toBe('Please explain the main trade-offs.');
});

test.each([
  { shiftKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true },
  { altKey: true }, { metaKey: true }, { repeat: true },
])('modified or held Tab does not accept (%j)', async (modifiers) => {
  const f = await fixture();
  f.type('Please explain'); await tick();
  const event = keyboard('Tab', modifiers);
  act(() => f.hook.result.current.onKeyDown(event));
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(f.hook.result.current.draft).toBe('Please explain');
});

test('Escape suppresses the same input; focus or timers do not resurrect it', async () => {
  const f = await fixture();
  f.type('Please explain'); await tick();
  act(() => f.hook.result.current.onKeyDown(keyboard('Escape')));
  f.type('Please explain'); await tick(5000);
  expect(f.hook.result.current.candidate).toBeNull();
  expect(api.composer.complete).toHaveBeenCalledOnce();
});

test('a late response cannot survive cancellation or an A → B → A edit', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(api.composer.complete).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const f = await fixture();
  f.type('Please explain'); await tick();
  const [body, signal] = vi.mocked(api.composer.complete).mock.calls[0];
  f.type('different text');
  f.type('Please explain');
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response(body, ' STALE')));
  expect(f.hook.result.current.candidate).toBeNull();
  expect(f.hook.result.current.draft).toBe('Please explain');
});

test.each(['scope', 'history', 'blocked', 'active'] as const)('changing %s invalidates context immediately', async (field) => {
  const f = await fixture();
  f.type('Please explain'); await tick();
  act(() => f.hook.rerender({
    scope: field === 'scope' ? 'session-b' : 'session-a',
    blocked: field === 'blocked', active: field !== 'active',
    history: field === 'history' ? [{ type: 'user', content: 'Different context.', timestamp: 2 }] : history,
    refuseEdit: false,
  }));
  expect(f.hook.result.current.candidate).toBeNull();
  await tick(5000);
  expect(api.composer.complete).toHaveBeenCalledOnce();
});

test('programmatic restore/rewrite and selection changes never initiate completion', async () => {
  const f = await fixture();
  f.programmatic('A restored or rewritten draft');
  await tick(5000);
  expect(api.composer.complete).not.toHaveBeenCalled();
  f.type('Please explain', 2); await tick(3000);
  expect(api.composer.complete).not.toHaveBeenCalled();
  f.type('Please explain'); await tick();
  act(() => {
    f.textarea.setSelectionRange(0, 3);
    f.hook.result.current.onSelectionChange();
  });
  expect(f.hook.result.current.candidate).toBeNull();
});

test('IME composition suspends requests and keyboard acceptance until committed text', async () => {
  const f = await fixture();
  act(() => f.hook.result.current.onCompositionStart());
  f.type('请检查'); await tick(3000);
  expect(api.composer.complete).not.toHaveBeenCalled();
  act(() => f.hook.result.current.onCompositionEnd('请检查'));
  await tick();
  expect(api.composer.complete).toHaveBeenCalledOnce();
  const event = keyboard('Tab', { nativeEvent: { isComposing: true } });
  act(() => f.hook.result.current.onKeyDown(event));
  expect(event.preventDefault).not.toHaveBeenCalled();
});

test('consent off, secrets, unfinished code blocks, and long input do not reach the model', async () => {
  const f = await fixture();
  for (const prefix of ['token=private-value', '```sh\nplease explain', '中'.repeat(1400), 'a']) {
    f.type(prefix); await tick(3000);
  }
  expect(api.composer.complete).not.toHaveBeenCalled();
  act(() => f.hook.result.current.setPreference({ completionEnabled: false }));
  f.type('Please explain'); await tick(3000);
  expect(api.composer.complete).not.toHaveBeenCalled();
});

test.each([false, null])('unavailable configuration (%s) allows opt-out but never new opt-in', async (available) => {
  vi.mocked(api.composer.config).mockResolvedValueOnce(available === null
    ? new Response('{}', { status: 503 })
    : new Response(JSON.stringify({ ...config, configured: false })));
  const f = await fixture(undefined, false);
  await tick();
  expect(f.hook.result.current.ready).toBe(true);
  expect(f.hook.result.current.configured).toBe(false);
  act(() => f.hook.result.current.setPreference({ completionEnabled: false }));
  expect(f.hook.result.current.preferences.completionEnabled).toBe(false);
  act(() => f.hook.result.current.setPreference({ completionEnabled: true }));
  expect(f.hook.result.current.preferences.completionEnabled).toBe(false);
  act(() => f.hook.result.current.setPreference({ useHistory: false }));
  expect(f.hook.result.current.preferences.useHistory).toBe(false);
  f.type('Please explain'); await tick(3000);
  expect(api.composer.complete).not.toHaveBeenCalled();
});

test('history opt-out sends no dialogue and undo never overwrites later edits', async () => {
  const f = await fixture();
  act(() => f.hook.result.current.setPreference({ useHistory: false }));
  f.type('Please explain'); await tick();
  expect(vi.mocked(api.composer.complete).mock.calls[0][0].history).toEqual([]);
  act(() => f.hook.result.current.accept());
  f.type('Please explain the main trade-offs. Keep my later edit');
  expect(f.hook.result.current.canUndo).toBe(false);
  act(() => f.hook.result.current.undo());
  expect(f.hook.result.current.draft).toContain('Keep my later edit');
});

test('429 observes its cooldown without scheduled retries', async () => {
  vi.mocked(api.composer.complete).mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '10' } }));
  const f = await fixture();
  f.type('Please explain'); await tick();
  expect(f.hook.result.current.phase).toBe('cooldown');
  f.type('Please explain more'); await tick(3000);
  expect(api.composer.complete).toHaveBeenCalledOnce();
  await tick(15000);
  expect(api.composer.complete).toHaveBeenCalledOnce();
});

test('logging out cancels work and unhydrated mirror values cannot re-enable it', async () => {
  const f = await fixture();
  f.type('Please explain');
  act(() => resetUserPreferences());
  act(() => writeUserPreference('composerPreferences', { completionEnabled: true, useHistory: true }));
  await tick(3000);
  expect(api.composer.complete).not.toHaveBeenCalled();
  expect(f.hook.result.current.ready).toBe(false);
});

test('late preference hydration cannot restore automatic consent after logout', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(api.user.preferences).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = hydrateUserPreferences();
  resetUserPreferences();
  finish(new Response(JSON.stringify({ preferences: { composerPreferences: { completionEnabled: true } } })));
  await pending;
  expect(hasHydratedUserPreferences()).toBe(false);
});
