import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import '@/modules/i18n';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';

test('Google SDK approvals do not offer to save rules into Claude settings', () => {
  const decide = vi.fn();
  const remember = vi.fn(() => ({ success: true }));
  render(
    <PermissionRequestsBanner
      providerLabel="Google Antigravity"
      pendingPermissionRequests={[{
        requestId: 'google-approval', toolName: 'create_file',
        input: { TargetFile: '/workspace/new.txt' }, context: { canRemember: false },
      }]}
      handlePermissionDecision={decide}
      handleGrantToolPermission={remember}
    />,
  );
  expect(screen.queryByText('Allow & remember')).toBeNull();
  expect(screen.queryByText('Always allow')).toBeNull();
  fireEvent.click(screen.getByText('Allow once'));
  expect(decide).toHaveBeenCalledWith('google-approval', { allow: true });
  expect(remember).not.toHaveBeenCalled();
});
