import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project, ProjectSession, SessionActivityState } from '@/shared/types';

/**
 * In the Codey Workbench the chat header is what stays on screen once its
 * session list is put away, so the header shows the session's state the way
 * the list does: a short coloured bar under the session's icon, with no text
 * to crowd the title on a phone. Amber waits for the user, blue pulses while
 * a turn runs and holds still while only background or scheduled work is left.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [] }),
}));

vi.mock('@/shared/ui', () => ({
  LLMProviderLogo: () => null,
}));

const { default: WorkspaceTitle } = await import('@/modules/project-workspace/WorkspaceTitle');

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
};

const session: ProjectSession = {
  id: 'session-1',
  summary: 'Train the AI',
  __provider: 'claude',
  __projectId: 'project-1',
};

const renderTitle = (sessionState: SessionActivityState | null, activeTab: 'chat' | 'files' = 'chat') => render(
  <WorkspaceTitle
    activeTab={activeTab}
    selectedProject={project}
    selectedSession={session}
    sessionState={sessionState}
    shouldShowTasksTab={false}
    onRenameSession={async () => true}
  />,
);

test('each busy state is a bar under the icon, named for screen readers and on hover', () => {
  const expected: Array<[SessionActivityState, string, string]> = [
    ['running', 'Running', 'bg-primary'],
    ['background', 'Background work', 'bg-primary'],
    ['waiting', 'Waiting for your input', 'bg-amber-500'],
  ];
  for (const [state, label, colour] of expected) {
    const { unmount } = renderTitle(state);
    const bar = screen.getByRole('img', { name: label });
    assert.equal(bar.getAttribute('title'), label);
    assert.ok(bar.classList.contains(colour), `${state} is ${colour}`);
    assert.equal(bar.className.includes('animate-pulse'), state === 'running', 'only a running turn pulses');
    assert.equal(screen.getByRole('heading', { level: 2 }).textContent, 'Train the AI', 'the title keeps its text');
    unmount();
  }
});

test('an idle session, or a tab other than the chat, has no bar', () => {
  const idle = renderTitle(null);
  assert.equal(screen.queryByRole('img'), null);
  idle.unmount();

  renderTitle('running', 'files');
  assert.equal(screen.queryByRole('img'), null);
});
