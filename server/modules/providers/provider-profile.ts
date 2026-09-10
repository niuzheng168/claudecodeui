import type { LLMProvider } from '@/shared/types.js';

export const CLOUDCLI_PROVIDER_PROFILES = ['full', 'codex-only'] as const;
export type CloudCliProviderProfile = typeof CLOUDCLI_PROVIDER_PROFILES[number];

const PROVIDERS_BY_PROFILE: Record<CloudCliProviderProfile, readonly LLMProvider[]> = {
  full: ['claude', 'codex', 'cursor', 'opencode'],
  'codex-only': ['codex'],
};

/**
 * Resolves the server provider profile. Ordinary CloudCLI keeps the full
 * provider set; Codey packages set codex-only explicitly in their service env.
 */
export function resolveCloudCliProviderProfile(
  value = process.env.CLOUDCLI_PROVIDER_PROFILE,
): CloudCliProviderProfile {
  const normalized = value?.trim() || 'full';
  if (CLOUDCLI_PROVIDER_PROFILES.includes(normalized as CloudCliProviderProfile)) {
    return normalized as CloudCliProviderProfile;
  }
  throw new Error(
    `Unsupported CLOUDCLI_PROVIDER_PROFILE "${normalized}". Expected full or codex-only.`,
  );
}

export function providersForProfile(
  profile: CloudCliProviderProfile,
): LLMProvider[] {
  return [...PROVIDERS_BY_PROFILE[profile]];
}
