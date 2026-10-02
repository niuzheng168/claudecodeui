import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { ComponentProps } from 'react';

import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => true }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['codex']) }));
vi.mock('@/shared/api', () => ({
  api: { providerSessionId: async () => ({ ok: true, json: async () => ({ data: { sessionId: 'native-id' } }) }) },
}));

test.each([false, true])('mobile session options expose fork even when source is running (%s)', isProcessing => {
  const onForkSession = vi.fn();
  const props = {
    project: { projectId: 'p', name: 'p', fullPath: '/p' },
    session: { id: 's', summary: 'Conversation', __provider: 'codex' },
    selectedSession: null, isProcessing, needsAttention: false, currentTime: new Date('2026-10-02'),
    isEditing: false, renameDraft: '',
    onForkSession, onRenameDraftChange: vi.fn(), onStartEditingSession: vi.fn(),
    onCancelEditingSession: vi.fn(), onSaveEditingSession: vi.fn(), onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(), onDeleteSession: vi.fn(), t: (key: string) => key,
  } as unknown as ComponentProps<typeof SidebarSessionItem>;
  render(<UiPreferencesProvider><SidebarSessionItem {...props} /></UiPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Session options for Conversation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fork session' }));
  expect(onForkSession).toHaveBeenCalledExactlyOnceWith(props.session);
  expect(screen.queryByRole('dialog')).toBeNull();
});
