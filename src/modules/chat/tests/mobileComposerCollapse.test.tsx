import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useInlineCompletion } from '@/modules/chat/hooks/useInlineCompletion';
import type { VoiceInputState } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  voiceState: 'idle' as VoiceInputState,
  voiceEnabled: false,
  rewriteBusy: false,
  rewriteNotice: undefined as string | undefined,
  rewriteOriginalText: undefined as string | undefined,
  invalidate: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options: Record<string, unknown> = {}) => {
      const labels: Record<string, string> = {
        'composer.collapseInput': 'Collapse input',
        'composer.expandInput': 'Expand input',
        'composer.moreTools': 'More tools',
        'input.send': 'Send',
        'input.attachFiles': 'Attach files',
        'input.stop': 'Stop',
        'input.steer.send': 'Steer now',
        'input.steer.sending': 'Sending correction…',
        'input.steer.voiceBusy': 'Finish or cancel voice input before appending the queued message.',
        'input.steer.rewriteBusy': 'Finish or cancel voice rewriting before appending the queued message.',
        'voice.rewrite.action': 'Rewrite voice text',
        'voice.rewrite.original': 'View original voice text',
        'voice.rewrite.draftChanged': 'The draft changed. The old snapshot will not overwrite your edits.',
      };
      return labels[key] || options.defaultValue || key;
    },
  }),
}));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ voiceEnabled: mocks.voiceEnabled }),
}));
vi.mock('@/shared/hooks/useCodeyVoice', () => ({
  useCodeyVoice: () => ({ preferences: { provider: 'azure-speech', language: 'auto' }, config: null }),
}));
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({
  useVoiceAvailable: () => false,
}));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: mocks.voiceState }),
}));
vi.mock('@/modules/chat/hooks/useVoiceRewrite', () => ({
  useVoiceRewrite: () => ({
    busy: mocks.rewriteBusy, notice: mocks.rewriteNotice, originalText: mocks.rewriteOriginalText,
  }),
}));
vi.mock('@/modules/chat/hooks/useInlineCompletion', () => ({
  useInlineCompletion: vi.fn(() => ({
    candidate: null,
    configured: true,
    ready: true,
    preferences: { completionEnabled: true, useHistory: true },
    phase: 'idle',
    notice: null,
    canUndo: false,
    setPreference: vi.fn(),
    invalidate: mocks.invalidate,
    isComposing: () => false,
  })),
}));

const originalWidth = window.innerWidth;

function resizeViewport(width: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  mocks.voiceState = 'idle';
  mocks.voiceEnabled = false;
  mocks.rewriteBusy = false;
  mocks.rewriteNotice = undefined;
  mocks.rewriteOriginalText = undefined;
  vi.clearAllMocks();
  resizeViewport(390);
});

afterEach(() => {
  resizeViewport(originalWidth);
  vi.unstubAllEnvs();
});

function fixture(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  const props: ComponentProps<typeof ChatComposer> = {
    pendingPermissionRequests: [],
    handlePermissionDecision: vi.fn(),
    handleGrantToolPermission: vi.fn(() => ({ success: false })),
    activity: null,
    isLoading: false,
    onAbortSession: vi.fn(),
    permissionMode: 'default',
    availablePermissionModes: ['default'],
    onSelectPermissionMode: vi.fn(),
    providerLabel: 'Codex',
    effort: 'high',
    availableEffortOptions: [],
    onSelectEffort: vi.fn(),
    model: 'test-model',
    availableModelOptions: [{ value: 'test-model', label: 'Test model' }],
    onSelectModel: vi.fn(),
    modelsLoading: false,
    tokenBudget: null,
    onShowTokenUsage: vi.fn(),
    slashCommandsCount: 0,
    onToggleCommandMenu: vi.fn(),
    hasInput: true,
    onClearInput: vi.fn(),
    onSubmit: vi.fn(),
    isDragActive: false,
    queuedDraft: null,
    isEditingSentMessage: false,
    onCancelEditMessage: vi.fn(),
    scheduledMessages: [],
    onScheduleMessage: vi.fn(),
    onCancelScheduledMessage: vi.fn(),
    onEditQueuedDraft: vi.fn(),
    onDeleteQueuedDraft: vi.fn(),
    attachedFiles: [],
    onRemoveAttachment: vi.fn(),
    fileErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: vi.fn(),
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: vi.fn(),
    onCloseCommandMenu: vi.fn(),
    isCommandMenuOpen: false,
    frequentCommands: [],
    getRootProps: () => ({}),
    getInputProps: () => ({ type: 'file' }),
    openAttachmentPicker: vi.fn(),
    inputHighlightRef: createRef<HTMLDivElement>(),
    renderInputWithMentions: (input) => input,
    textareaRef: createRef<HTMLTextAreaElement>(),
    input: 'An unsent draft\nwith another line',
    onInputChange: vi.fn(),
    onTextareaClick: vi.fn(),
    onTextareaKeyDown: vi.fn(),
    onTextareaPaste: vi.fn(),
    onTextareaScrollSync: vi.fn(),
    onTextareaInput: vi.fn(),
    onInputFocusChange: vi.fn(),
    placeholder: 'Write a message',
    isTextareaExpanded: false,
    ...overrides,
  };
  return { ...render(<ChatComposer {...props} />), props };
}

test.each([320, 390, 1024])('queued steering sits beside Edit/Delete outside the form at %ipx', (width) => {
  resizeViewport(width);
  const onSteerQueued = vi.fn();
  const f = fixture({ isLoading: true, onSteerQueued, canSteer: true, queuedDraft: { content: 'Queued correction', attachments: [] } });
  const button = screen.getByRole('button', { name: 'Steer now' });
  expect(button.getAttribute('type')).toBe('button');
  const actions = f.container.querySelector('[data-slot="queued-message-actions"]');
  expect(actions?.contains(button)).toBe(true);
  expect(actions?.contains(screen.getByRole('button', { name: 'Edit queued message' }))).toBe(true);
  expect(actions?.contains(screen.getByRole('button', { name: 'Delete queued message' }))).toBe(true);
  expect(button.closest('form')).toBeNull();
  expect(f.container.querySelector('[data-slot="composer-steering"]')).toBeNull();
  fireEvent.click(button);
  expect(onSteerQueued).toHaveBeenCalledTimes(1);
  expect(f.props.onSubmit).not.toHaveBeenCalled();
  expect(f.props.onAbortSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Update queued message' }));
  expect(f.props.onSubmit).toHaveBeenCalledTimes(1);
  expect(onSteerQueued).toHaveBeenCalledTimes(1);
});

test('even supported runs have no immediate action before a message is queued', () => {
  fixture({ isLoading: true, onSteerQueued: vi.fn(), canSteer: true });
  expect(screen.queryByRole('button', { name: 'Steer now' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Queue next message' })).toBeTruthy();
});

test('steering submission disables duplicate sends, Edit and Delete without changing the textarea', () => {
  const onSteerQueued = vi.fn();
  const f = fixture({ isLoading: true, isSteering: true, onSteerQueued, canSteer: true, queuedDraft: { content: 'Queued correction', attachments: [] } });
  fireEvent.click(screen.getByRole('button', { name: 'Sending correction…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete queued message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Update queued message' }));
  expect(onSteerQueued).not.toHaveBeenCalled();
  expect(f.props.onEditQueuedDraft).not.toHaveBeenCalled();
  expect(f.props.onDeleteQueuedDraft).not.toHaveBeenCalled();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(f.props.input);
});

test.each([320, 390, 1024])('an old node at %ipx explains the disabled immediate action instead of hiding it', (width) => {
  resizeViewport(width);
  const onSteerQueued = vi.fn();
  const reason = 'Update the node backend to enable Send now.';
  const f = fixture({ isLoading: true, onSteerQueued, canSteer: false, steerUnavailableReason: reason, queuedDraft: { content: 'Queued correction', attachments: [] } });
  const immediate = screen.getByRole('button', { name: 'Steer now' }) as HTMLButtonElement;
  expect(immediate.disabled).toBe(true);
  expect(immediate.title).toBe(reason);
  const explanation = screen.getByText(reason);
  expect(explanation.getAttribute('role')).toBe('status');
  expect(explanation.closest('[data-slot="queued-message"]')).toBeTruthy();
  expect(immediate.getAttribute('aria-describedby')).toBe(explanation.id);
  fireEvent.click(immediate);
  expect(onSteerQueued).not.toHaveBeenCalled();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
  expect(f.props.onAbortSession).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(f.props.input);
  fireEvent.click(screen.getByRole('button', { name: 'Update queued message' }));
  expect(f.props.onSubmit).toHaveBeenCalledOnce();
});

test('steering is disabled until advertised and enables in place without removing the queue option', () => {
  const onSteerQueued = vi.fn();
  const reason = 'Checking support for the active run.';
  const f = fixture({ isLoading: true, onSteerQueued, steerUnavailableReason: reason, queuedDraft: { content: 'Queued correction', attachments: [] } });
  const immediate = screen.getByRole('button', { name: 'Steer now' }) as HTMLButtonElement;
  expect(immediate.disabled).toBe(true);
  expect(screen.getByText(reason)).toBeTruthy();
  f.rerender(<ChatComposer {...f.props} canSteer />);
  expect(immediate.disabled).toBe(false);
  expect(immediate.getAttribute('aria-describedby')).toBeNull();
  expect(screen.queryByText(reason)).toBeNull();
  fireEvent.click(immediate);
  expect(onSteerQueued).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Update queued message' })).toBeTruthy();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
  expect(f.props.onAbortSession).not.toHaveBeenCalled();
});

test('an unavailable action keeps its explanation visible while the mobile input is collapsed', () => {
  const reason = 'Update the node backend to enable Send now.';
  fixture({ isLoading: true, onSteerQueued: vi.fn(), steerUnavailableReason: reason, queuedDraft: { content: 'Queued correction', attachments: [] } });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  expect(screen.getByText(reason).closest('[aria-hidden="true"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Expand input' })).toBeTruthy();
});

test.each([
  { isSteering: true },
  { steerError: 'Check the previous delivery.' },
  { held: true },
])('pending delivery and review feedback take priority over an availability hint (%j)', ({ held, ...overrides }) => {
  const reason = 'Update the node backend to enable Send now.';
  fixture({
    isLoading: true, onSteerQueued: vi.fn(), canSteer: false, steerUnavailableReason: reason,
    queuedDraft: { content: 'Queued correction', attachments: [], ...(held ? { steerHold: 'unconfirmed' } : {}) },
    ...overrides,
  });
  expect(screen.queryByText(reason)).toBeNull();
});

test('a rejected correction stays visible even when the turn has ended', () => {
  const f = fixture({ isLoading: false, steerError: 'The turn ended; draft kept', queuedDraft: { content: 'Queued correction', attachments: [] } });
  expect(screen.getByRole('alert').textContent).toContain('The turn ended; draft kept');
  expect(screen.getByRole('alert').closest('[data-slot="queued-message"]')).toBeTruthy();
  expect(f.container.querySelector('form')?.contains(screen.getByRole('alert'))).toBe(false);
  expect(screen.queryByRole('button', { name: 'Steer now' })).toBeNull();
});

test('immediate append remains accessible while the mobile input is collapsed', () => {
  const onSteerQueued = vi.fn();
  const f = fixture({ isLoading: true, onSteerQueued, canSteer: true, queuedDraft: { content: 'Queued correction', attachments: [] } });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  fireEvent.click(screen.getByRole('button', { name: 'Steer now' }));
  expect(onSteerQueued).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Expand input' })).toBeTruthy();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
});

test('unconfirmed queued delivery offers review/edit, not another immediate attempt', () => {
  const onSteerQueued = vi.fn();
  const f = fixture({ isLoading: true, onSteerQueued, canSteer: true, queuedDraft: { content: 'Review first', attachments: [], steerHold: 'unconfirmed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Steer now' }));
  expect(onSteerQueued).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe('input.queue.reviewHint');
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
  expect(f.props.onEditQueuedDraft).toHaveBeenCalledOnce();
});

test.each(['recording', 'requesting', 'transcribing'] as const)('queued append is disabled during voice %s', (voiceState) => {
  mocks.voiceState = voiceState;
  const onSteerQueued = vi.fn();
  fixture({ isLoading: true, onSteerQueued, canSteer: true, queuedDraft: { content: 'Queued correction', attachments: [] } });
  const reason = screen.getByText('Finish or cancel voice input before appending the queued message.');
  expect(screen.getByRole('button', { name: 'Steer now' }).getAttribute('aria-describedby')).toBe(reason.id);
  fireEvent.click(screen.getByRole('button', { name: 'Steer now' }));
  expect(onSteerQueued).not.toHaveBeenCalled();
});

test('a busy rewrite explains its own lock and restores immediate append when finished', () => {
  mocks.rewriteBusy = true;
  const onSteerQueued = vi.fn();
  const f = fixture({ isLoading: true, onSteerQueued, canSteer: true, queuedDraft: { content: 'Queued correction', attachments: [] } });
  const reason = 'Finish or cancel voice rewriting before appending the queued message.';
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Steer now' }));
  expect(onSteerQueued).not.toHaveBeenCalled();
  mocks.rewriteBusy = false;
  f.rerender(<ChatComposer {...f.props} />);
  expect(screen.queryByText(reason)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Steer now' }));
  expect(onSteerQueued).toHaveBeenCalledOnce();
});

test('backend incompatibility is not misreported as a temporary voice lock', () => {
  mocks.voiceState = 'recording';
  const reason = 'Update the node backend to enable Send now.';
  fixture({ isLoading: true, onSteerQueued: vi.fn(), steerUnavailableReason: reason, queuedDraft: { content: 'Queued correction', attachments: [] } });
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.queryByText('Finish or cancel voice input before appending the queued message.')).toBeNull();
});

test.each([320, 390, 767])('mobile at %ipx places the accessible collapse toggle in the existing status row', (width) => {
  resizeViewport(width);
  const f = fixture();
  const toggle = screen.getByRole('button', { name: 'Collapse input' });
  const form = f.container.querySelector('[data-slot="prompt-input"]')!;
  expect(toggle.getAttribute('type')).toBe('button');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.contains(screen.getByRole('textbox'))).toBe(true);
  expect(toggle.closest('[data-slot="composer-status"]')).toBe(f.container.querySelector('[data-slot="composer-status"]'));
  expect(form.contains(toggle)).toBe(true);
  expect(form.classList.contains('rounded-t-none')).toBe(false);
  expect(form.classList.contains('transition-[border-color,border-radius,box-shadow]')).toBe(true);
  expect(form.classList.contains('transition-all')).toBe(false);
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
});

test('explicit folding and unfolding transfer keyboard focus without focusing the textarea or submitting', () => {
  const f = fixture();
  const collapse = screen.getByRole('button', { name: 'Collapse input' });
  const contentId = collapse.getAttribute('aria-controls');
  act(() => collapse.focus());
  fireEvent.click(collapse);
  const expand = screen.getByRole('button', { name: 'Expand input' });
  expect(expand.getAttribute('aria-controls')).toBe(contentId);
  expect(document.activeElement).toBe(expand);
  expect(f.container.querySelector('[data-slot="prompt-input"]')?.contains(expand)).toBe(false);
  fireEvent.click(expand);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse input' }));
  expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  expect(f.props.onSubmit).not.toHaveBeenCalled();
  expect(f.props.onAbortSession).not.toHaveBeenCalled();
});

test('the activity indicator still joins the mobile composer without a separate collapse header', () => {
  const f = fixture({
    isLoading: true,
    activity: { startedAt: Date.now(), statusText: 'Working', canInterrupt: true },
  });
  expect(f.container.querySelector('[data-slot="prompt-input"]')?.classList.contains('rounded-t-none')).toBe(true);
  expect(screen.getByRole('button', { name: 'Collapse input' }).closest('[data-slot="composer-status"]')).not.toBeNull();
  expect(screen.getByText('Working…')).toBeTruthy();
});

test('folding removes the editing controls, dismisses the keyboard, and preserves draft, selection and attachments', () => {
  const f = fixture({ attachedFiles: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] });
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  textarea.style.height = '160px';
  textarea.setSelectionRange(3, 8);
  act(() => textarea.focus());
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));

  const toggle = screen.getByRole('button', { name: 'Expand input' });
  const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(content.getAttribute('aria-hidden')).toBe('true');
  expect(content.classList.contains('h-0')).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  expect(document.activeElement).not.toBe(textarea);
  expect(f.props.onInputFocusChange).toHaveBeenCalledWith(false);
  expect(f.props.onCloseCommandMenu).toHaveBeenCalledOnce();
  expect(mocks.invalidate).toHaveBeenCalled();
  expect(vi.mocked(useInlineCompletion).mock.lastCall?.[0].blocked).toBe(true);
  expect(f.props.textareaRef.current).toBe(textarea);

  fireEvent.click(toggle);
  expect(screen.getByRole('textbox')).toBe(textarea);
  expect(textarea.value).toBe(f.props.input);
  expect(textarea.style.height).toBe('160px');
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 8]);
  expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeTruthy();
  expect(vi.mocked(useInlineCompletion).mock.lastCall?.[0].blocked).toBe(false);
  expect(f.props.onClearInput).not.toHaveBeenCalled();
  expect(f.props.onRemoveAttachment).not.toHaveBeenCalled();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
});

test.each([768, 1024, 1440])('desktop at %ipx never exposes folding controls', (width) => {
  resizeViewport(width);
  const f = fixture();
  expect(screen.queryByRole('button', { name: /(?:Collapse|Expand) input/ })).toBeNull();
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(f.container.querySelector('[data-slot="prompt-input"]')?.classList.contains('rounded-t-none')).toBe(false);
});

test('switching to desktop always reveals the composer even after folding it on mobile', () => {
  fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  resizeViewport(1024);
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /(?:Collapse|Expand) input/ })).toBeNull();
  resizeViewport(390);
  expect(screen.getByRole('button', { name: 'Expand input' })).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('responsive layout changes do not steal focus from the draft or an outside control', () => {
  const f = fixture();
  const textarea = screen.getByRole('textbox');
  act(() => textarea.focus());
  resizeViewport(1024);
  expect(document.activeElement).toBe(textarea);
  resizeViewport(390);
  expect(document.activeElement).toBe(textarea);

  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  const outside = document.createElement('button');
  f.container.append(outside);
  act(() => outside.focus());
  resizeViewport(1024);
  resizeViewport(390);
  expect(document.activeElement).toBe(outside);
});

test('a portaled tools menu closes when folded and does not reopen with the composer', () => {
  fixture();
  fireEvent.click(screen.getByRole('button', { name: 'More tools' }));
  expect(screen.getByRole('menu', { name: 'More tools' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand input' }));
  expect(screen.queryByRole('menu')).toBeNull();
});

test('managed completion lives in the toolbar and its popup closes when the mobile composer folds', () => {
  vi.stubEnv('VITE_CODEY_PORTAL_SSO', 'true');
  const f = fixture();
  const completion = screen.getByRole('button', { name: 'completion.title · completion.on' });
  expect(f.container.querySelector('[data-slot="prompt-input-tools"]')?.contains(completion)).toBe(true);
  expect(f.container.querySelector('[data-slot="prompt-input-body"]')?.nextElementSibling?.getAttribute('role')).toBe('status');
  fireEvent.click(completion);
  expect(screen.getByRole('dialog', { name: 'completion.title' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand input' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'completion.title · completion.on' })).toBeTruthy();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
});

test.each([320, 390, 1024])('voice rewrite details at %ipx occupy no input row and open only from the rewrite tool', (width) => {
  resizeViewport(width);
  vi.stubEnv('VITE_CODEY_PORTAL_SSO', 'true');
  mocks.voiceEnabled = true;
  mocks.rewriteNotice = 'draftChanged';
  mocks.rewriteOriginalText = 'A recorded voice fragment';
  const f = fixture({ voiceContextKey: 'session-a' });
  const trigger = screen.getByRole('button', { name: 'Rewrite voice text' });
  const notice = screen.getByText('The draft changed. The old snapshot will not overwrite your edits.');
  expect(notice.classList.contains('sr-only')).toBe(true);
  expect(f.container.querySelector('[data-slot="composer-primary"]')?.contains(notice)).toBe(true);
  expect(screen.queryByText('View original voice text')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'voice.rewrite.options' });
  expect(within(dialog).getByText('View original voice text')).toBeTruthy();
  expect(f.container.contains(dialog)).toBe(false);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(f.props.input);
  expect(f.props.onSubmit).not.toHaveBeenCalled();
  expect(f.props.onClearInput).not.toHaveBeenCalled();

  // A new session must not inherit an open details popup from the previous draft.
  f.rerender(<ChatComposer {...f.props} voiceContextKey="session-b" />);
  expect(screen.queryByRole('dialog')).toBeNull();
  if (width < 768) {
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite voice text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand input' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  }
});

test('the processing status and Stop action remain accessible while folded', () => {
  const f = fixture({
    isLoading: true,
    activity: { startedAt: Date.now(), statusText: 'Working', canInterrupt: true },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  expect(screen.getByText('Working…')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(f.props.onAbortSession).toHaveBeenCalledOnce();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
});

test('permission decisions stay outside the folded input', () => {
  const f = fixture({
    pendingPermissionRequests: [{ requestId: 'permission-1', toolName: 'Bash', input: { command: 'pwd' } }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  expect(f.props.handlePermissionDecision).toHaveBeenCalledWith('permission-1', { allow: true });
});

test('editing a previous message reveals its draft', () => {
  const f = fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  f.rerender(<ChatComposer {...f.props} isEditingSentMessage input="Earlier message" />);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Earlier message');
  expect(screen.getByRole('button', { name: 'Collapse input' })).toBeTruthy();
});

test('editing a queued message reopens the composer without sending or deleting it', () => {
  const f = fixture({ queuedDraft: { content: 'Queued message', attachments: [] } });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse input' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
  expect(f.props.onEditQueuedDraft).toHaveBeenCalledOnce();
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(f.props.onDeleteQueuedDraft).not.toHaveBeenCalled();
  expect(f.props.onSubmit).not.toHaveBeenCalled();
});

test.each(['requesting', 'recording', 'transcribing'] as const)('folding is disabled during voice %s', (state) => {
  mocks.voiceState = state;
  fixture();
  const toggle = screen.getByRole('button', { name: 'Collapse input' }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
  fireEvent.click(toggle);
  expect(screen.getByRole('textbox')).toBeTruthy();
});

test('folding is disabled during a voice rewrite', () => {
  mocks.rewriteBusy = true;
  fixture();
  expect((screen.getByRole('button', { name: 'Collapse input' }) as HTMLButtonElement).disabled).toBe(true);
});
