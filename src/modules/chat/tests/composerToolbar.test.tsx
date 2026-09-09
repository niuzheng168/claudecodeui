import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ComposerToolbar } from '@/modules/chat/composer/ComposerToolbar';
import { ComposerCompletionControl } from '@/modules/chat/composer/ComposerCompletionControl';
import { ComposerVoiceControl } from '@/modules/chat/composer/ComposerVoiceControl';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import { PromptInput, PromptInputSubmit } from '@/modules/chat/composer/PromptInput';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import type { CodeyVoiceConfig, VoiceInputState } from '@/shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options: Record<string, unknown> = {}) => {
      const labels: Record<string, string> = {
        'voice.input': 'Voice input', 'voice.options': 'Voice options', 'voice.cancel': 'Cancel voice input',
        'voice.stopRecording': 'Stop recording', 'voiceSettings.provider': 'Voice service',
        'voiceSettings.language': 'Language', 'voiceSettings.autoLanguage': 'Auto detect',
        'voiceSettings.refresh': 'Refresh voice services', 'composer.moreTools': 'More tools',
        'composer.backToTools': 'Back to tools', 'composer.tokenUsage': 'Show token usage',
        'composer.tokenCount': '{{tokens}} tokens', 'composer.tokensUsed': '{{tokens}} tokens used',
        'input.showAllCommands': 'Show all commands', 'input.clearInput': 'Clear input',
        'input.attachFiles': 'Attach files', 'schedule.trigger': 'Schedule message',
        'schedule.heading': 'Send later', 'schedule.customLabel': 'Choose time',
        'schedule.confirm': 'Confirm schedule', 'schedule.in.15': 'In 15 minutes',
        'schedule.in.60': 'In 1 hour', 'schedule.in.480': 'In 8 hours', 'schedule.in.1440': 'Tomorrow',
      };
      return String(labels[key] || options.defaultValue || key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''));
    },
  }),
}));

const config: CodeyVoiceConfig = {
  userId: 'fixture-only', maxDurationSeconds: 120, languages: ['auto', 'zh-CN', 'en-US'], defaultProvider: 'azure-speech',
  providers: [
    { id: 'azure-speech', label: 'Azure Speech', configured: true },
    { id: 'mai-transcribe', label: 'MAI Transcribe', configured: true },
  ],
};
const fullModelLabel = 'GPT-6 Astra (872K context)';
const originalViewport = { width: window.innerWidth, height: window.innerHeight };

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalViewport.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalViewport.height });
});

function fixture({ hasInput = false, state = 'idle', error = null }: { hasInput?: boolean; state?: VoiceInputState; error?: string | null } = {}) {
  const callbacks = {
    attach: vi.fn(), mic: vi.fn(), cancel: vi.fn(), voiceChange: vi.fn(), refresh: vi.fn(),
    tokens: vi.fn(), commands: vi.fn(), clear: vi.fn(), schedule: vi.fn(), model: vi.fn(),
    effort: vi.fn(), permission: vi.fn(), submit: vi.fn(), collapse: vi.fn(),
  };
  const result = render(
    <PromptInput onSubmit={(event) => { event.preventDefault(); callbacks.submit(); }}>
      <textarea aria-label="Draft" defaultValue={hasInput ? 'A draft' : ''} />
      <ComposerToolbar onAttachFiles={callbacks.attach}
        collapseControl={<button type="button" onClick={callbacks.collapse}>Collapse input</button>}
        completionControl={<ComposerCompletionControl configured ready
          preferences={{ completionEnabled: true, useHistory: true }} onPreferenceChange={vi.fn()} />}
        voiceControl={<ComposerVoiceControl state={state} disabled={false} onToggle={callbacks.mic} onCancel={callbacks.cancel}
          managed={{ config, preferences: { provider: 'azure-speech', language: 'auto' }, onChange: callbacks.voiceChange,
            onRefresh: callbacks.refresh, loadFailed: false }} />}
        modelControl={<ComposerModelMenu effort="max" effortOptions={[{ value: 'high' }, { value: 'max' }]}
          onSelectEffort={callbacks.effort} model="gpt-6-astra" modelOptions={[{ value: 'gpt-6-astra', label: fullModelLabel }]}
          onSelectModel={callbacks.model} modelsLoading={false} />}
        permissionControl={<ComposerPermissionMenu permissionMode="default" permissionModes={['default', 'plan']}
          providerLabel="Codex" onSelectPermissionMode={callbacks.permission} />}
        submitControl={<PromptInputSubmit aria-label="Send" disabled={!hasInput} />}
        tokenUsage={{ used: 12345 }} onShowTokenUsage={callbacks.tokens}
        commandsCount={12} onShowCommands={callbacks.commands} hasInput={hasInput} onClearInput={callbacks.clear}
        canSchedule={hasInput} onSchedule={callbacks.schedule} submitHint="Enter to send" hideHint={false}
        voiceError={error} />
    </PromptInput>,
  );
  return { ...result, callbacks };
}

test('the primary row hides secondary settings, uses a short model label and keeps permissions/send visible', () => {
  const f = fixture();
  const primary = f.container.querySelector('[data-slot="composer-primary"]')!;
  expect(primary.querySelectorAll('select')).toHaveLength(0);
  expect(primary.textContent).not.toContain('tokens');
  expect(primary.textContent).not.toContain('872K');
  expect(primary.textContent).not.toContain('12');
  expect(screen.getByRole('button', { name: /Select model and reasoning effort/ }).getAttribute('title')).toContain(fullModelLabel);
  expect(screen.getByRole('button', { name: /How should Codex/ })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Schedule message' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show token usage' }));
  expect(f.callbacks.attach).toHaveBeenCalledOnce();
  expect(f.callbacks.tokens).toHaveBeenCalledOnce();
  expect(f.callbacks.submit).not.toHaveBeenCalled();
});

test('completion shares the attachment tool row instead of reserving a settings row', () => {
  const f = fixture();
  const completion = screen.getByRole('button', { name: 'completion.title · completion.on' });
  const attachment = screen.getByRole('button', { name: 'Attach files' });
  expect(completion.closest('[data-slot="prompt-input-tools"]')).toBe(attachment.closest('[data-slot="prompt-input-tools"]'));
  expect(f.container.querySelector('[data-slot="composer-primary"]')?.contains(completion)).toBe(true);
  expect(completion.textContent).toBe('');
  expect(screen.queryByLabelText('completion.enable')).toBeNull();
});

test('collapse shares the token status row without crowding the primary actions or submitting', () => {
  const f = fixture();
  const collapse = screen.getByRole('button', { name: 'Collapse input' });
  const tokens = screen.getByRole('button', { name: 'Show token usage' });
  expect(collapse.closest('[data-slot="composer-status"]')).toBe(tokens.closest('[data-slot="composer-status"]'));
  expect(f.container.querySelector('[data-slot="composer-primary"]')?.contains(collapse)).toBe(false);
  fireEvent.click(collapse);
  expect(f.callbacks.collapse).toHaveBeenCalledOnce();
  expect(f.callbacks.submit).not.toHaveBeenCalled();
});

test('voice options disclose selectors without starting recording and Escape returns keyboard focus', async () => {
  const f = fixture();
  const trigger = screen.getByRole('button', { name: 'Voice options' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Voice options' });
  const service = within(dialog).getByRole('combobox', { name: 'Voice service' });
  await waitFor(() => expect(document.activeElement).toBe(service));
  fireEvent.change(service, { target: { value: 'mai-transcribe' } });
  expect(f.callbacks.voiceChange).toHaveBeenCalledWith({ provider: 'mai-transcribe' });
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Language' }), { target: { value: 'zh-CN' } });
  expect(f.callbacks.voiceChange).toHaveBeenCalledWith({ language: 'zh-CN' });
  expect(f.callbacks.mic).not.toHaveBeenCalled();
  expect(f.callbacks.submit).not.toHaveBeenCalled();
  fireEvent.keyDown(service, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test.each(['requesting', 'recording', 'transcribing'] as const)('voice settings are locked while %s and cancellation remains reachable', (state) => {
  const f = fixture({ state });
  fireEvent.click(screen.getByRole('button', { name: 'Voice options' }));
  for (const select of screen.getAllByRole('combobox')) expect((select as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Refresh voice services' }) as HTMLButtonElement).disabled).toBe(true);
  if (state === 'recording') {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    expect(f.callbacks.cancel).toHaveBeenCalledOnce();
  } else {
    fireEvent.click(screen.getByRole('button', { name: /^Cancel voice input ·/ }));
    expect(f.callbacks.mic).toHaveBeenCalledOnce();
  }
  expect(f.callbacks.voiceChange).not.toHaveBeenCalled();
});

test('more tools keeps command counts and disables draft-only actions when empty', () => {
  const f = fixture();
  fireEvent.click(screen.getByRole('button', { name: 'More tools' }));
  const menu = screen.getByRole('menu', { name: 'More tools' });
  expect(within(menu).getByText('12')).toBeTruthy();
  expect((within(menu).getByRole('menuitem', { name: /Schedule message/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(menu).getByRole('menuitem', { name: 'Clear input' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Show all commands/ }));
  expect(f.callbacks.commands).toHaveBeenCalledOnce();
  expect(f.callbacks.submit).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});

test('a scheduled draft is selected inside the same popup without accidentally sending it immediately', async () => {
  const f = fixture({ hasInput: true });
  fireEvent.click(screen.getByRole('button', { name: 'More tools' }));
  const schedule = screen.getByRole('menuitem', { name: 'Schedule message' });
  fireEvent.click(schedule);
  const dialog = screen.getByRole('dialog', { name: 'Send later' });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Back to tools' })));
  fireEvent.pointerDown(within(dialog).getByRole('button', { name: /In 15 minutes/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: /In 15 minutes/ }));
  expect(f.callbacks.schedule).toHaveBeenCalledOnce();
  expect(Math.abs(f.callbacks.schedule.mock.calls[0][0].getTime() - Date.now() - 15 * 60000)).toBeLessThan(2000);
  expect(f.callbacks.submit).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('invalid custom times cannot schedule; back navigation and clearing preserve their distinct actions', () => {
  const f = fixture({ hasInput: true });
  fireEvent.click(screen.getByRole('button', { name: 'More tools' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Schedule message' }));
  fireEvent.change(screen.getByLabelText('Choose time'), { target: { value: '2000-01-01T00:00' } });
  expect((screen.getByRole('button', { name: 'Confirm schedule' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Back to tools' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Clear input' }));
  expect(f.callbacks.clear).toHaveBeenCalledOnce();
  expect(f.callbacks.schedule).not.toHaveBeenCalled();
  expect(f.callbacks.submit).not.toHaveBeenCalled();
});

test('model and effort values are unchanged by shortening their toolbar presentation', async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole('button', { name: /Select model and reasoning effort/ }));
  const selected = screen.getByRole('menuitemradio', { name: 'max' });
  await waitFor(() => expect(document.activeElement).toBe(selected));
  fireEvent.click(selected);
  expect(f.callbacks.effort).toHaveBeenCalledWith('max');
  fireEvent.click(screen.getByRole('button', { name: /Select model and reasoning effort/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: fullModelLabel }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: fullModelLabel }));
  expect(f.callbacks.model).toHaveBeenCalledWith('gpt-6-astra');
  expect(f.callbacks.submit).not.toHaveBeenCalled();
});

test('errors have a full-width alert rather than a clipped tooltip beside the mic', () => {
  const f = fixture({ error: 'Microphone denied' });
  expect(screen.getByRole('alert').textContent).toBe('Microphone denied');
  expect(f.container.querySelector('[data-slot="composer-primary"]')?.contains(screen.getByRole('alert'))).toBe(false);
});

test.each(['start', 'end'] as const)('%s-aligned popovers fit a narrow iframe instead of extending off its left edge', (align) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
  const hook = renderHook(() => useComposerMenuAnchor(false, vi.fn(), 320, align));
  const button = document.createElement('button');
  button.getBoundingClientRect = () => new DOMRect(16, 580, 24, 32);
  hook.result.current.triggerRef.current = button;
  act(() => hook.result.current.updateAnchor());
  const anchor = hook.result.current.anchor!;
  expect(anchor.maxWidth).toBeLessThanOrEqual(304);
  expect(320 - anchor.right - anchor.maxWidth).toBeGreaterThanOrEqual(8);
  expect(anchor.right).toBeGreaterThanOrEqual(8);
  expect(anchor.bottom).toBe(68);
});

test('a trigger near the top opens its controls below instead of clipping them above the viewport', () => {
  const hook = renderHook(() => useComposerMenuAnchor(false, vi.fn()));
  const button = document.createElement('button');
  button.getBoundingClientRect = () => new DOMRect(80, 12, 24, 32);
  hook.result.current.triggerRef.current = button;
  act(() => hook.result.current.updateAnchor());
  expect(hook.result.current.anchor?.top).toBe(52);
  expect(hook.result.current.anchor?.bottom).toBeUndefined();
});
