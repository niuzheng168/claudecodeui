import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ComposerCompletionBar } from '@/modules/chat/composer/ComposerCompletionBar';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

test('mobile Complete/Dismiss/Undo controls never submit a chat form', () => {
  const submit = vi.fn((event) => event.preventDefault());
  const accept = vi.fn(), dismiss = vi.fn(), undo = vi.fn();
  render(<form onSubmit={submit}>
    <ComposerCompletionBar
      candidate={{ prefix: 'Please explain', suffix: ' the main trade-offs.', context: 'test', scope: 'test', expiresAt: Date.now() + 10000 }}
      ghostVisible={false} configured ready preferences={{ completionEnabled: true, useHistory: true }}
      phase="idle" notice="applied" canUndo onPreferenceChange={() => {}}
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

test('consent cannot be enabled until both identity-bound config and preferences are ready', () => {
  render(<ComposerCompletionBar candidate={null} ghostVisible={false} configured={false} ready={false}
    preferences={{ completionEnabled: false, useHistory: true }} phase="idle" notice={null} canUndo={false}
    onPreferenceChange={() => {}} onAccept={() => {}} onDismiss={() => {}} onUndo={() => {}} />);
  expect((screen.getByLabelText('completion.enable') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('completion.history') as HTMLInputElement).disabled).toBe(true);
});

test('existing consent can still be revoked when completion is unavailable', () => {
  const change = vi.fn();
  render(<ComposerCompletionBar candidate={null} ghostVisible={false} configured={false} ready
    preferences={{ completionEnabled: true, useHistory: true }} phase="idle" notice={null} canUndo={false}
    onPreferenceChange={change} onAccept={() => {}} onDismiss={() => {}} onUndo={() => {}} />);
  const enabled = screen.getByLabelText('completion.enable') as HTMLInputElement;
  expect(enabled.disabled).toBe(false);
  fireEvent.click(enabled);
  expect(change).toHaveBeenCalledWith({ completionEnabled: false });
});
