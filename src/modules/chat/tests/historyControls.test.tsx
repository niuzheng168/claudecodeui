import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/chat/transcript/MessageComponent', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ToolGroupContainer', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ChatExportMenu', () => ({ default: () => null }));
vi.mock('@/modules/chat/transcript/ProviderSelectionEmptyState', () => ({ default: () => null }));

function props(): ComponentProps<typeof ChatMessagesPane> {
  const messages = [{ type: 'assistant' as const, content: 'Latest message', timestamp: '2026-09-19T00:00:00Z' }];
  return {
    scrollContainerRef: createRef(), onWheel: vi.fn(), onTouchMove: vi.fn(),
    isLoadingSessionMessages: false, chatMessages: messages, selectedSession: null, currentSessionId: 'a',
    provider: 'codex', setProvider: vi.fn(), textareaRef: createRef(),
    providerModels: { codex: '', claude: '', cursor: '', opencode: '' }, setProviderModel: vi.fn(),
    providerModelCatalog: {}, providerModelActions: {} as never, providerModelsLoading: false,
    tasksEnabled: false, isTaskMasterInstalled: false, setInput: vi.fn(),
    isLoadingMoreMessages: false, hasMoreMessages: true, totalMessages: 1601, sessionMessagesCount: 20,
    visibleMessageCount: 100, visibleMessages: messages, loadEarlierMessages: vi.fn(), loadAllMessages: vi.fn(),
    allMessagesLoaded: false, isLoadingAllMessages: false, loadAllJustFinished: false, showLoadAllOverlay: false,
    createDiff: vi.fn(), onGrantToolPermission: () => ({ success: true }),
    selectedProject: { projectId: 'p', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false },
  };
}

test('earlier/all controls remain reachable after the transient top overlay disappears', () => {
  const options = props();
  const { rerender } = render(<ChatMessagesPane {...options} />);
  const earlier = screen.getByRole('button', { name: 'session.messages.loadEarlier' });
  fireEvent.click(earlier);
  fireEvent.click(screen.getByRole('button', { name: 'session.messages.loadAll' }));
  expect(options.loadEarlierMessages).toHaveBeenCalledTimes(1);
  expect(options.loadAllMessages).toHaveBeenCalledTimes(1);
  rerender(<ChatMessagesPane {...options} isLoadingMoreMessages />);
  expect(earlier.hasAttribute('disabled')).toBe(true);
  rerender(<ChatMessagesPane {...options} hasMoreMessages={false} visibleMessageCount={0} />);
  expect(screen.getByRole('button', { name: 'session.messages.loadEarlier' })).toBeTruthy();
});

test('an initial history failure has a visible retry even when no messages could be rendered', () => {
  const options = props();
  render(<ChatMessagesPane {...options} chatMessages={[]} historyError="Connection interrupted" />);
  expect(screen.getByRole('alert').textContent).toContain('Connection interrupted');
  fireEvent.click(screen.getByRole('button', { name: 'session.messages.loadAll' }));
  expect(options.loadAllMessages).toHaveBeenCalledTimes(1);
});
