import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

const SUMMARY: ChatMessage = {
  type: 'assistant',
  content: 'This session is being continued from a previous conversation.\n\nSummary:\n1. The user asked for OK.',
  timestamp: '2026-10-20T17:14:50Z',
  isCompactSummary: true,
};

test('a compaction summary stays folded under one line until opened', () => {
  render(
    <UiPreferencesProvider>
      <MessageComponent message={SUMMARY} prevMessage={null} createDiff={() => []} provider="claude" />
    </UiPreferencesProvider>,
  );

  const toggle = screen.getByRole('button', { name: /compacted conversation|compactSummary\.title/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText(/The user asked for OK/)).not.toBeNull();
});

test('an exported transcript shows the compaction summary in full', () => {
  render(
    <TranscriptRenderContext.Provider value={{ isExporting: true }}>
      <MessageComponent message={SUMMARY} prevMessage={null} createDiff={() => []} provider="claude" />
    </TranscriptRenderContext.Provider>,
  );

  expect(screen.getByRole('button', { name: /compacted conversation|compactSummary\.title/ })
    .getAttribute('aria-expanded')).toBe('true');
});
