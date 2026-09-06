import { IS_PLATFORM, isCodeyManagedDeployment } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';

/** Selects the CLI login command used by the provider-auth modal. */
export function resolveProviderLoginCommand({
  provider,
  customCommand,
  isAuthenticated: _isAuthenticated,
  useCodexDeviceAuth = IS_PLATFORM || isCodeyManagedDeployment(),
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated: boolean;
  useCodexDeviceAuth?: boolean;
}) {
  if (customCommand) {
    return customCommand;
  }

  if (provider === 'claude') {
    return 'claude --dangerously-skip-permissions /login';
  }

  if (provider === 'cursor') {
    return 'cursor-agent login';
  }

  if (provider === 'codex') {
    return useCodexDeviceAuth ? 'codex login --device-auth' : 'codex login';
  }

  if (provider === 'opencode') {
    return 'opencode auth login';
  }

  return 'claude --dangerously-skip-permissions /login';
}
