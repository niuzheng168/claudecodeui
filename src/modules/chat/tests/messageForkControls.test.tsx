import { fireEvent, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

vi.mock('@/modules/chat/transcript/ChatMessageImages', () => ({ default: () => <span>image attachment</span> }));
vi.mock('@/modules/chat/transcript/ChatMessageFiles', () => ({ default: () => <span>file attachment</span> }));

test.each([
  { type: 'user', content: 'prompt' },
  { type: 'user', content: '', images: [{ path: '/image.png' }] },
  { type: 'user', content: '', files: [{ name: 'a.txt', path: '/a.txt' }] },
  { type: 'assistant', content: 'reply' },
  { type: 'assistant', content: 'notification', isTaskNotification: true },
] as Partial<ChatMessage>[])('fork is available without hover on $type / $content including attachments', partial => {
  const onFork = vi.fn();
  const onEdit = vi.fn();
  const message = { timestamp: '2026-10-02T00:00:00Z', ...partial, forkAnchorId: 'native-turn' } as ChatMessage;
  const { container } = render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="codex"
        onForkFromMessage={onFork} onEditMessage={onEdit} />
    </UiPreferencesProvider>,
  );
  const fork = container.querySelector('button[aria-label="Fork from here"]')
    ?? container.querySelector('button[aria-label="message.forkFromHere"]');
  expect(fork).not.toBeNull();
  expect(fork?.className).not.toContain('opacity-0');
  fireEvent.click(fork!);
  expect(onFork).toHaveBeenCalledWith(message);
  expect(container.querySelector('[aria-label="message.editAndResend"]')).toBeNull();
});

test('document exports do not include fork/edit actions', () => {
  const { container } = render(
    <TranscriptRenderContext.Provider value={{ isExporting: true }}>
      <MessageComponent message={{
        type: 'user', content: 'prompt', timestamp: '2026-10-02', forkAnchorId: 'turn', transcriptAnchorId: 'turn',
      }} prevMessage={null} createDiff={() => []} provider="codex"
        onForkFromMessage={() => {}} onEditMessage={() => {}} />
    </TranscriptRenderContext.Provider>,
  );
  expect(container.querySelector('button')).toBeNull();
});
