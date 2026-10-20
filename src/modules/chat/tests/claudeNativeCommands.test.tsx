import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { resetUserPreferences } from '@/shared/userSettings';
import type { LLMProvider, PermissionMode, Project, SlashCommand } from '@/shared/types';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';

const PROJECT: Project = { projectId: 'project', fullPath: '/fixture-project', displayName: 'Fixture' };
const builtIn = (name: string) => ({ name, namespace: 'builtin', metadata: { type: 'builtin' } });
const native = (name: string, provider: LLMProvider) => ({
  name, description: `${name} from ${provider}`, namespace: 'builtin', metadata: { type: 'native', provider },
});
const CATALOG: Record<string, unknown[]> = {
  claude: [builtIn('/cost'), native('/compact', 'claude'), native('/context', 'claude'), native('/simplify', 'claude')],
  codex: [builtIn('/cost'), native('/goal', 'codex'), native('/plan', 'codex')],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  resetUserPreferences();
  vi.stubGlobal('fetch', vi.fn(async () => json([])));
  vi.spyOn(api.commands, 'list').mockImplementation(async (_, provider) =>
    json({ builtIn: CATALOG[provider as string] ?? [], custom: [] }));
  // The user's own /simplify skill takes the slot of Claude Code's.
  vi.spyOn(api.providers, 'skills').mockImplementation(async () => json({ data: { skills: [
    { name: 'simplify', description: 'My own simplify', command: '/simplify', scope: 'user' },
  ] } }));
  vi.spyOn(api.commands, 'execute').mockImplementation(async () =>
    json({ type: 'builtin', action: 'cost', data: { tokenUsage: { used: 0, total: 0 } } }));
});

afterEach(() => {
  resetChatDrafts();
  resetUserPreferences();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Props = { provider: LLMProvider; busy: boolean };

async function fixture(overrides: Partial<Props> = {}) {
  const sendMessage = vi.fn(), addMessage = vi.fn();
  const view = renderHook(({ provider, busy }: Props) => useChatComposerState({
    selectedProject: PROJECT, selectedSession: { id: 'app' }, currentSessionId: 'app', provider,
    permissionMode: 'default', selectPermissionMode: () => {}, cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: (_, mode) => mode as PermissionMode,
    currentProviderModel: 'test-model', currentProviderEffort: 'high',
    isLoading: busy, canAbortSession: busy, tokenBudget: null, sendMessage, addMessage,
    scrollToBottom: () => {}, setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  }), { initialProps: { provider: 'claude', busy: false, ...overrides } as Props });
  await waitFor(() => expect(view.result.current.slashCommandsCount).toBeGreaterThan(1));
  const input = async (value: string) => { await act(async () => { view.result.current.setInput(value); }); };
  const submit = async () => {
    await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  };
  const names = () => view.result.current.filteredCommands.map((command: SlashCommand) => command.name);
  return { ...view, input, submit, names, sendMessage, addMessage };
}

test('the menu offers Claude Code commands in Claude chats only, behind the user\'s own commands', async () => {
  const f = await fixture();
  await waitFor(() => expect(f.names()).toContain('/compact'));
  expect(f.names()).toContain('/context');
  expect(f.result.current.filteredCommands.filter((command: SlashCommand) => command.name === '/simplify'))
    .toEqual([expect.objectContaining({ type: 'skill' })]);

  f.rerender({ provider: 'codex', busy: false });
  await waitFor(() => expect(f.names()).toContain('/goal'));
  expect(f.result.current.filteredCommands.some((command: SlashCommand) => command.metadata?.provider === 'claude'))
    .toBe(false);
});

test('a Claude Code command is sent to Claude as a chat message, arguments and all', async () => {
  const f = await fixture();
  await f.input('/compact keep the API notes'); await f.submit();

  expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'chat.send', sessionId: 'app', content: '/compact keep the API notes',
  }));
  expect(api.commands.execute).not.toHaveBeenCalled();
  expect(f.result.current.input).toBe('');
});

test('a Claude Code command typed during a turn is queued like any message', async () => {
  const f = await fixture({ busy: true });
  await f.input('/compact'); await f.submit();

  expect(f.result.current.queuedDraft).toEqual(expect.objectContaining({ content: '/compact' }));
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(api.commands.execute).not.toHaveBeenCalled();
});

test('picking a Claude Code command completes it, and Enter on the exact name sends it', async () => {
  const f = await fixture();
  const compact = f.result.current.filteredCommands.find((command: SlashCommand) => command.name === '/compact') ?? null;
  await act(async () => { f.result.current.handleCommandSelect(compact, 0, false); });
  expect(f.result.current.input).toBe('/compact ');
  expect(f.sendMessage).not.toHaveBeenCalled();

  await act(async () => f.result.current.handleInputChange({
    target: { value: '/context', selectionStart: 8, style: {} },
  } as never));
  await act(async () => f.result.current.handleKeyDown({
    key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {},
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  } as never));
  await waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '/context' })));
  expect(api.commands.execute).not.toHaveBeenCalled();
});

test('Codey\'s own commands keep their names in Claude chats', async () => {
  const f = await fixture();
  await f.input('/cost'); await f.submit();

  expect(api.commands.execute).toHaveBeenCalledWith(expect.objectContaining({ commandName: '/cost' }));
  expect(f.sendMessage).not.toHaveBeenCalled();
});
