import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { resetUserPreferences } from '@/shared/userSettings';
import type { LLMProvider, PermissionMode, Project } from '@/shared/types';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';

const PROJECT: Project = { projectId: 'project', fullPath: '/fixture-project', displayName: 'Fixture' };
const COMMANDS = ['/goal', '/plan'].map((name) => ({
  name, namespace: 'builtin', metadata: { type: 'native', provider: 'codex' },
}));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  vi.stubGlobal('fetch', vi.fn(async () => json([])));
  vi.spyOn(api.commands, 'list').mockImplementation(async (_, provider) =>
    json({ builtIn: provider === 'codex' ? COMMANDS : [], custom: [] }));
  vi.spyOn(api.providers, 'skills').mockImplementation(async () => json({ data: { skills: [] } }));
  vi.spyOn(api.commands, 'goal').mockImplementation(async () => json({ goal: null, message: 'Native goal status' }));
});

afterEach(() => {
  resetUserPreferences();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Props = { session: string | null; provider: LLMProvider; busy: boolean; planAvailable?: boolean };

async function fixture(overrides: Partial<Props> = {}, nativeCommands = true) {
  const sendMessage = vi.fn(), addMessage = vi.fn(), onSessionEstablished = vi.fn();
  const view = renderHook(({ session, provider, busy, planAvailable }: Props) => {
    const [permissionMode, selectPermissionMode] = useState<PermissionMode>('default');
    const composer = useChatComposerState({
      selectedProject: PROJECT, selectedSession: session ? { id: session } : null,
      currentSessionId: session, provider, permissionMode, selectPermissionMode,
      cyclePermissionMode: () => {}, resolvePermissionModeForProvider: (_, mode) =>
        mode === 'plan' && planAvailable === false ? 'default' : mode as PermissionMode,
      currentProviderModel: 'test-model', currentProviderEffort: 'high',
      isLoading: busy, canAbortSession: busy, tokenBudget: null, sendMessage, addMessage,
      onSessionEstablished, scrollToBottom: () => {}, setIsUserScrolledUp: () => {},
      setPendingPermissionRequests: () => {},
    });
    return { ...composer, permissionMode };
  }, { initialProps: { session: 'app', provider: 'codex', busy: false, ...overrides } as Props });
  if (nativeCommands) await waitFor(() => expect(view.result.current.slashCommandsCount).toBe(2));
  else await act(async () => {});
  const input = async (value: string) => { await act(async () => { view.result.current.setInput(value); }); };
  const submit = async () => {
    await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  };
  return { ...view, input, submit, sendMessage, addMessage, onSessionEstablished };
}

test('/goal creates a tracked chat run with the exact multiline objective, not a REST mutation or prompt expansion', async () => {
  const f = await fixture();
  const command = '/goal --tokens 40000 Fix the issue\nand add tests.';
  await f.input(command); await f.submit();
  expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'chat.send', sessionId: 'app', content: command,
  }));
  expect(api.commands.goal).not.toHaveBeenCalled();
});

test('/goal pause/clear are controls even while a run is busy; never queued as chat text', async () => {
  const f = await fixture({ busy: true });
  for (const action of ['pause', 'clear']) {
    await f.input(`/goal ${action}`); await f.submit();
    expect(api.commands.goal).toHaveBeenLastCalledWith('app', action);
  }
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.result.current.queuedDraft).toBeNull();
});

test('/goal without a session shows help/status without allocating a conversation', async () => {
  const create = vi.spyOn(api.providers, 'createSession');
  const f = await fixture({ session: null });
  await f.input('/goal'); await f.submit();
  expect(api.commands.goal).toHaveBeenCalledWith(null, '');
  expect(create).not.toHaveBeenCalled();
  expect(f.sendMessage).not.toHaveBeenCalled();
});

test('goal control failures preserve the command draft', async () => {
  vi.mocked(api.commands.goal).mockImplementation(async () => json({ error: 'Native owner unavailable' }, 409));
  const f = await fixture();
  await f.input('/goal pause'); await f.submit();
  expect(f.result.current.input).toBe('/goal pause');
  expect(f.addMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', content: 'Native owner unavailable' }));
});

test('a late goal response cannot overwrite a different session or a newer draft', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(api.commands.goal).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const f = await fixture();
  await f.input('/goal edit');
  let pending!: Promise<void>;
  act(() => { pending = f.result.current.handleSubmit({ preventDefault() {} } as never); });
  f.rerender({ session: 'other', provider: 'codex', busy: false });
  await f.input('Other session draft');
  await act(async () => { finish(json({ message: 'Old session goal', draft: '/goal edit OLD' })); await pending; });
  expect(f.result.current.input).toBe('Other session draft');
  expect(f.addMessage).not.toHaveBeenCalled();
});

test('/plan toggles the real outgoing mode and /plan off returns to normal approvals', async () => {
  const f = await fixture();
  await f.input('/plan'); await f.submit();
  expect(f.result.current.permissionMode).toBe('plan');
  expect(f.sendMessage).not.toHaveBeenCalled();
  await f.input('Explore the design'); await f.submit();
  expect(f.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    options: expect.objectContaining({ permissionMode: 'plan', codexPlanMode: true }),
  }));
  await f.input('/plan off'); await f.submit();
  expect(f.result.current.permissionMode).toBe('default');
  await f.input('Implement it'); await f.submit();
  expect(f.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    options: expect.objectContaining({ permissionMode: 'default', codexPlanMode: false }),
  }));
});

test('/plan <prompt> sets plan options on the first send without waiting for React state', async () => {
  const f = await fixture();
  await f.input('/plan Design a migration'); await f.submit();
  expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: '/plan Design a migration',
    options: expect.objectContaining({ permissionMode: 'plan', codexPlanMode: true }),
  }));
});

test('Enter executes the exact native command before palette debounce, but Tab only completes it', async () => {
  const f = await fixture();
  const typePlan = async () => {
    await act(async () => f.result.current.handleInputChange({
      target: { value: '/plan', selectionStart: 5, style: {} },
    } as never));
  };
  const key = async (value: string) => {
    await act(async () => f.result.current.handleKeyDown({
      key: value, nativeEvent: { isComposing: false }, preventDefault() {},
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    } as never));
  };
  await typePlan(); await key('Tab');
  expect(f.result.current.input).toBe('/plan ');
  expect(f.result.current.permissionMode).toBe('default');
  await typePlan(); await key('Enter');
  await waitFor(() => expect(f.result.current.permissionMode).toBe('plan'));
  expect(f.result.current.input).toBe('');
  expect(api.commands.goal).not.toHaveBeenCalled();
  expect(f.sendMessage).not.toHaveBeenCalled();
});

test('an older backend or other provider cannot silently receive native commands as ordinary text', async () => {
  vi.mocked(api.commands.list).mockImplementation(async () => json({ builtIn: [], custom: [] }));
  const f = await fixture({}, false);
  for (const command of ['/goal Finish it', '/plan Design it']) {
    await f.input(command); await f.submit();
    expect(f.result.current.input).toBe(command);
  }
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.addMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', content: expect.stringContaining('not advertised') }));
  f.rerender({ session: 'app', provider: 'claude', busy: false });
  await f.input('/goal Finish it'); await f.submit();
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.addMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining('only for Codex') }));
});

test('starting a goal in Plan Mode is rejected without changing modes or losing the objective', async () => {
  const f = await fixture();
  await f.input('/plan on'); await f.submit();
  await f.input('/goal Finish it'); await f.submit();
  expect(f.result.current.input).toBe('/goal Finish it');
  expect(f.result.current.permissionMode).toBe('plan');
  expect(f.sendMessage).not.toHaveBeenCalled();
});

test('missing node Plan capability cannot be faked by a command catalog entry', async () => {
  const f = await fixture({ planAvailable: false });
  await f.input('/plan on'); await f.submit();
  expect(f.result.current.permissionMode).toBe('default');
  expect(f.result.current.input).toBe('/plan on');
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.addMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'error', content: expect.stringContaining('not available'),
  }));
});

test('double-submit cannot allocate two new native goal sessions', async () => {
  let finish!: (value: Response) => void;
  const create = vi.spyOn(api.providers, 'createSession').mockImplementation(() =>
    new Promise((resolve) => { finish = resolve; }));
  const f = await fixture({ session: null });
  await f.input('/goal Finish it');
  let first!: Promise<void>;
  act(() => { first = f.result.current.handleSubmit({ preventDefault() {} } as never); });
  await f.submit();
  expect(create).toHaveBeenCalledTimes(1);
  await act(async () => { finish(json({ data: { sessionId: 'created' } })); await first; });
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'created' }));
});

test('navigation while allocating a goal session cannot dispatch work or clear the newly selected draft', async () => {
  let finish!: (value: Response) => void;
  vi.spyOn(api.providers, 'createSession').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const f = await fixture({ session: null });
  await f.input('/goal Finish it');
  let pending!: Promise<void>;
  act(() => { pending = f.result.current.handleSubmit({ preventDefault() {} } as never); });
  f.rerender({ session: 'other', provider: 'codex', busy: false });
  await f.input('Other session draft');
  await act(async () => { finish(json({ data: { sessionId: 'created' } })); await pending; });
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.onSessionEstablished).not.toHaveBeenCalled();
  expect(f.result.current.input).toBe('Other session draft');
});

test('native Plan question UI returns stable ids and honors restricted/secret questions', async () => {
  const onDecision = vi.fn();
  const view = render(<AskUserQuestionPanel request={{
    requestId: 'question', toolName: 'AskUserQuestion', input: { questions: [{
      id: 'approach', question: 'Which migration?', options: [{ label: 'Small', description: 'Small change' }],
      allowOther: false,
    }] },
  }} onDecision={onDecision} />);
  expect(screen.queryByText('Other...')).toBeNull();
  fireEvent.click(screen.getByText('Small'));
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  expect(onDecision).toHaveBeenCalledWith('question', expect.objectContaining({
    updatedInput: expect.objectContaining({ answers: { approach: 'Small' } }),
  }));
  view.unmount();
  render(<AskUserQuestionPanel request={{
    requestId: 'secret', toolName: 'AskUserQuestion', input: { questions: [{
      id: 'secret', question: 'Secret?', options: [], isSecret: true,
    }] },
  }} onDecision={onDecision} />);
  fireEvent.click(screen.getByText('Other...'));
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
});
