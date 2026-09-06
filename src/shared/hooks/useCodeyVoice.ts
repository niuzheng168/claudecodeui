import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { CodeyVoiceConfig, CodeyVoicePreferences } from '@/shared/types';
import { getDeploymentBasePath } from '@/shared/utils';

// Coalesce concurrent capability checks, never cache credentials or audio.
const requests = new Map<string, Promise<CodeyVoiceConfig>>();
const SYNC_EVENT = 'codey-voice-preferences';

function requestConfig(): Promise<CodeyVoiceConfig> {
  const key = getDeploymentBasePath();
  const existing = requests.get(key);
  if (existing) return existing;
  const pending = api.voice.codeyConfig().then(async (response) => {
    if (!response.ok) throw new Error('Unable to load voice services.');
    const config = await response.json() as CodeyVoiceConfig;
    if (!config.userId || !Array.isArray(config.providers) ||
        !config.providers.every((item) => ['azure-speech', 'mai-transcribe'].includes(item.id)) ||
        !Array.isArray(config.languages) ||
        !Number.isFinite(config.maxDurationSeconds) || config.maxDurationSeconds < 1 || config.maxDurationSeconds > 120) {
      throw new Error('Invalid voice service configuration.');
    }
    return config;
  }).finally(() => { requests.delete(key); });
  requests.set(key, pending);
  return pending;
}

function storageKey(config: CodeyVoiceConfig): string {
  return `codey-voice:${config.userId}`;
}

function readPreferences(config: CodeyVoiceConfig): CodeyVoicePreferences {
  let stored: Partial<CodeyVoicePreferences> = {};
  try { stored = JSON.parse(localStorage.getItem(storageKey(config)) || '{}'); } catch { /* Defaults below. */ }
  const selectedProvider = config.providers.find((item) => item.id === stored?.provider);
  const selectedLanguage = config.languages.find((language) => language === stored?.language);
  return {
    provider: selectedProvider?.id || config.defaultProvider,
    language: selectedLanguage || 'auto',
    rewriteUseHistory: stored?.rewriteUseHistory !== false,
  };
}

/** Chat and settings select a server-managed service here without handling provider keys. */
export function useCodeyVoice(enabled: boolean) {
  // Capabilities carry the owner ID needed to separate preferences across accounts.
  const [config, setConfig] = useState<CodeyVoiceConfig | null>(null);
  // Only service/language choices are persisted, never recordings or transcripts.
  const [preferences, setPreferences] = useState<CodeyVoicePreferences>({ provider: 'azure-speech', language: 'auto' });
  // Distinguish an unavailable API from a deliberately unconfigured service.
  const [error, setError] = useState<string | null>(null);
  // An explicit retry fetches fresh capabilities without resetting the user's choice.
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setError(null);
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void requestConfig().then((value) => {
      if (!active) return;
      setError(null);
      setConfig(value);
      setPreferences(readPreferences(value));
    }).catch(() => {
      if (active) { setConfig(null); setError('Unable to load voice services.'); }
    });
    return () => { active = false; };
  }, [enabled, revision]);

  useEffect(() => {
    if (!enabled || !config) return;
    const read = () => setPreferences(readPreferences(config));
    const storage = (event: StorageEvent) => { if (event.key === storageKey(config)) read(); };
    window.addEventListener(SYNC_EVENT, read);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(SYNC_EVENT, read);
      window.removeEventListener('storage', storage);
    };
  }, [config, enabled]);

  const update = useCallback((patch: Partial<CodeyVoicePreferences>) => {
    if (!config) return;
    const next = { ...preferences, ...patch };
    if (!config.providers.some((item) => item.id === next.provider) || !config.languages.includes(next.language)) return;
    setPreferences(next);
    try {
      localStorage.setItem(storageKey(config), JSON.stringify(next));
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch { /* Recording also works without persistent browser storage. */ }
  }, [config, preferences]);

  return { config, preferences, update, refresh, error };
}
