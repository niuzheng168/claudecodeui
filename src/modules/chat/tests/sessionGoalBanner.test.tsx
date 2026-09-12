import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SessionGoalBanner } from '@/modules/chat/SessionGoalBanner';
import { i18n } from '@/modules/i18n';
import type { CodexSessionGoal } from '@/shared/types';

const goal: CodexSessionGoal = {
  objective: '先实现桌面和手机端。\n再检查与设计稿一致。',
  status: 'active', tokenBudget: null, tokensUsed: 324672, timeUsedSeconds: 3140,
};
const props = (overrides: Partial<ComponentProps<typeof SessionGoalBanner>> = {}) => ({
  goal, loading: false, error: null, onRefresh: vi.fn(), ...overrides,
});
const renderBanner = (overrides: Partial<ComponentProps<typeof SessionGoalBanner>> = {}) =>
  render(<I18nextProvider i18n={i18n}><SessionGoalBanner {...props(overrides)} /></I18nextProvider>);

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });
afterEach(async () => { await i18n.changeLanguage('en'); });

test('a persisted active goal displays its objective, native usage, unlimited budget and elapsed time in Chinese', () => {
  renderBanner();
  expect(screen.getByRole('region', { name: 'Goal' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('执行中');
  expect(screen.getByText(/先实现桌面和手机端/).textContent).toBe(goal.objective);
  expect(screen.getByText('Token：324,672 / 不限')).toBeTruthy();
  expect(screen.getByText('耗时：0:52:20')).toBeTruthy();
});

test.each([
  ['paused', '已暂停'], ['blocked', '受阻'], ['usageLimited', '已达用量限制'],
  ['budgetLimited', '已达 Token 预算'], ['complete', '已完成'],
] as const)('the native %s state is displayed distinctly, not inferred from chat activity', (status, label) => {
  renderBanner({ goal: { ...goal, status, tokenBudget: 400000 } });
  expect(screen.getByRole('status').textContent).toBe(label);
  expect(screen.getByText('Token：324,672 / 400,000')).toBeTruthy();
});

test('no goal reserves no empty banner, but read failures have an explicit retry path', () => {
  const view = renderBanner({ goal: null });
  expect(view.container.textContent).toBe('');
  view.unmount();
  const refresh = vi.fn();
  renderBanner({ goal: null, error: 'unsupported', onRefresh: refresh });
  expect(screen.getByText(/请更新此节点的 Codey 后端/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '刷新 Goal 状态' }));
  expect(refresh).toHaveBeenCalledOnce();
});

test('a stale goal remains visible but is not presented as currently running', () => {
  const view = renderBanner({ error: 'unavailable' });
  expect(screen.getByText('上次状态：执行中')).toBeTruthy();
  expect(screen.getByText('状态更新失败，显示上次确认的目标。')).toBeTruthy();
  expect(screen.getByText('Token：324,672 / 不限')).toBeTruthy();
  expect(view.container.querySelector('.animate-pulse')).toBeNull();
});

test('expanding long objectives and refreshing never submit chat or mutate the goal', () => {
  const refresh = vi.fn();
  const submit = vi.fn((event) => event.preventDefault());
  render(<I18nextProvider i18n={i18n}><form onSubmit={submit}>
    <SessionGoalBanner {...props({ onRefresh: refresh })} />
  </form></I18nextProvider>);
  const expand = screen.getByRole('button', { name: '展开完整目标' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  const objective = document.getElementById(expand.getAttribute('aria-controls')!)!;
  expect(objective.className).toContain('line-clamp-2');
  fireEvent.click(expand);
  expect(screen.getByRole('button', { name: '折叠目标' }).getAttribute('aria-expanded')).toBe('true');
  expect(objective.className).toContain('overflow-y-auto');
  fireEvent.click(screen.getByRole('button', { name: '刷新 Goal 状态' }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});

test('goals render as text, loading disables refresh and English remains available', async () => {
  await i18n.changeLanguage('en');
  const view = renderBanner({ goal: { ...goal, objective: '<img src=x onerror=alert(1)>' }, loading: true });
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  expect(view.container.querySelector('img')).toBeNull();
  expect((screen.getByRole('button', { name: 'Refresh goal status' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('Running');
});
