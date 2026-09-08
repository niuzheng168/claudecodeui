import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ComposerCompletionBar } from '@/modules/chat/composer/ComposerCompletionBar';
import { ComposerCompletionControl } from '@/modules/chat/composer/ComposerCompletionControl';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function barProps(overrides: Partial<ComponentProps<typeof ComposerCompletionBar>> = {}): ComponentProps<typeof ComposerCompletionBar> {
  return {
    candidate: null, ghostVisible: false, preferences: { completionEnabled: true, useHistory: true },
    phase: 'idle', notice: null, canUndo: false,
    onAccept: vi.fn(), onDismiss: vi.fn(), onUndo: vi.fn(), ...overrides,
  };
}

test.each([true, false])('idle completion reserves no row when enabled=%s', (completionEnabled) => {
  const { container } = render(<ComposerCompletionBar {...barProps({
    preferences: { completionEnabled, useHistory: true },
  })} />);
  expect(container.querySelector('[data-completion-controls]')).toBeNull();
  expect(container.querySelector('details')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('');
});

test.each(['requesting', 'cooldown', 'unavailable'])('completion still shows a useful %s notice', (phase) => {
  const { container, rerender } = render(<ComposerCompletionBar {...barProps({ phase })} />);
  expect(container.querySelector('[data-completion-controls]')?.textContent).toBe(`completion.${phase}`);
  rerender(<ComposerCompletionBar {...barProps({ phase, preferences: { completionEnabled: false, useHistory: true } })} />);
  expect(container.querySelector('[data-completion-controls]')).toBeNull();
});

test('undo is announced without leaving an empty candidate row behind', () => {
  const { container } = render(<ComposerCompletionBar {...barProps({ notice: 'undone' })} />);
  expect(screen.getByRole('status').textContent).toBe('completion.undone');
  expect(container.querySelector('[data-completion-controls]')).toBeNull();
});

test('mobile Complete/Dismiss/Undo controls never submit a chat form', () => {
  const submit = vi.fn((event) => event.preventDefault());
  const accept = vi.fn(), dismiss = vi.fn(), undo = vi.fn();
  render(<form onSubmit={submit}>
    <ComposerCompletionBar
      candidate={{ prefix: 'Please explain', suffix: ' the main trade-offs.', context: 'test', scope: 'test', expiresAt: Date.now() + 10000 }}
      ghostVisible={false} preferences={{ completionEnabled: true, useHistory: true }}
      phase="idle" notice="applied" canUndo
      onAccept={accept} onDismiss={dismiss} onUndo={undo} />
  </form>);
  expect(screen.getByText('the main trade-offs.', { exact: false })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /completion.accept/ }));
  fireEvent.click(screen.getByRole('button', { name: 'completion.dismiss' }));
  fireEvent.click(screen.getByRole('button', { name: 'completion.undo' }));
  expect(accept).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
  expect(undo).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /completion.accept/ }).className).toContain('min-h-11');
});

test.each([
  { configured: false, ready: false },
  { configured: false, ready: true },
  { configured: true, ready: false },
])('consent requires both identity-bound config and preferences: %o', ({ configured, ready }) => {
  render(<ComposerCompletionControl configured={configured} ready={ready}
    preferences={{ completionEnabled: false, useHistory: true }} onPreferenceChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'completion.title · completion.off' }));
  expect((screen.getByLabelText('completion.enable') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('completion.history') as HTMLInputElement).disabled).toBe(!ready);
});

test('existing consent can still be revoked when completion is unavailable', () => {
  const change = vi.fn();
  render(<ComposerCompletionControl configured={false} ready
    preferences={{ completionEnabled: true, useHistory: true }} onPreferenceChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'completion.title · completion.on' }));
  const enabled = screen.getByLabelText('completion.enable') as HTMLInputElement;
  expect(enabled.disabled).toBe(false);
  fireEvent.click(enabled);
  expect(change).toHaveBeenCalledWith({ completionEnabled: false });
});

test('the compact completion trigger opens a portalled settings dialog without submitting or toggling consent', async () => {
  const submit = vi.fn((event) => event.preventDefault());
  const change = vi.fn();
  const { container } = render(<form onSubmit={submit}>
    <ComposerCompletionControl configured ready
      preferences={{ completionEnabled: false, useHistory: true }} onPreferenceChange={change} />
  </form>);
  const trigger = screen.getByRole('button', { name: 'completion.title · completion.off' });
  expect(trigger.textContent).toBe('');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.hasAttribute('data-completion-controls')).toBe(true);
  expect(screen.queryByLabelText('completion.enable')).toBeNull();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'completion.title' });
  expect(container.contains(dialog)).toBe(false);
  expect(within(dialog).getByText('completion.consent')).toBeTruthy();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(change).not.toHaveBeenCalled();
  const enabled = within(dialog).getByLabelText('completion.enable');
  await waitFor(() => expect(document.activeElement).toBe(enabled));
  expect(enabled.closest('[data-completion-controls]')).not.toBeNull();
  fireEvent.click(enabled);
  fireEvent.click(within(dialog).getByLabelText('completion.history'));
  expect(change.mock.calls).toEqual([[{ completionEnabled: true }], [{ useHistory: false }]]);
  fireEvent.keyDown(enabled, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(submit).not.toHaveBeenCalled();
});
