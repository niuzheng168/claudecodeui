import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import {
  providersForProfile,
  resolveCloudCliProviderProfile,
} from '@/modules/providers/provider-profile.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const profile = resolveCloudCliProviderProfile();
const enabledProviderIds = providersForProfile(profile);
const providers = new Map<LLMProvider, IProvider>();

if (profile === 'full') {
  const [
    { ClaudeProvider },
    { CursorProvider },
    { OpenCodeProvider },
  ] = await Promise.all([
    import('@/modules/providers/list/claude/claude.provider.js'),
    import('@/modules/providers/list/cursor/cursor.provider.js'),
    import('@/modules/providers/list/opencode/opencode.provider.js'),
  ]);
  providers.set('claude', new ClaudeProvider());
  providers.set('codex', new CodexProvider());
  providers.set('cursor', new CursorProvider());
  providers.set('opencode', new OpenCodeProvider());
} else {
  providers.set('codex', new CodexProvider());
}

if (
  providers.size !== enabledProviderIds.length
  || enabledProviderIds.some((provider) => !providers.has(provider))
) {
  throw new Error(`CloudCLI provider profile "${profile}" was initialized incompletely.`);
}

/**
 * Central registry for resolving concrete provider implementations by id.
 */
export const providerRegistry = {
  profile,

  listProviders(): IProvider[] {
    return [...providers.values()];
  },

  listProviderIds(): LLMProvider[] {
    return [...providers.keys()];
  },

  hasProvider(provider: string): boolean {
    return providers.has(provider as LLMProvider);
  },

  resolveProvider(provider: string): IProvider {
    const key = provider as LLMProvider;
    const resolvedProvider = providers.get(key);
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  },
};
