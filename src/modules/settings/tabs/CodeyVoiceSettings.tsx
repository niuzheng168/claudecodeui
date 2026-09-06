import { useTranslation } from 'react-i18next';

import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useCodeyVoice } from '@/shared/hooks/useCodeyVoice';
import { CodeyVoiceSelectors } from '@/shared/ui/CodeyVoiceSelectors';

/** Settings' voice tab uses the Codey broker instead of asking users to store API keys in browsers. */
export function CodeyVoiceSettings() {
  const { t } = useTranslation('settings');
  const { voiceEnabled } = useUiPreferences();
  const setPreference = useSetUiPreference();
  const voice = useCodeyVoice(true);
  return (
    <div className="space-y-6">
      <SettingsSection title={t('voiceSettings.inputTitle')} description={t('voiceSettings.managedDescription')}>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
          <span className="text-sm font-medium">{t('voiceSettings.enableInput')}</span>
          <SettingsToggle checked={voiceEnabled} onChange={(value) => setPreference('voiceEnabled', value)}
            ariaLabel={t('voiceSettings.enableInput')} />
        </div>
      </SettingsSection>
      <SettingsSection title={t('voiceSettings.backendTitle')} description={t('voiceSettings.managedKeys')}>
        {voice.config && (
          <div className="space-y-4">
            <CodeyVoiceSelectors config={voice.config} preferences={voice.preferences} onChange={voice.update} />
            <ul className="space-y-2 text-sm">
              {voice.config.providers.map((provider) => (
                <li key={provider.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{provider.label}</span>
                  <span className={provider.configured ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}>
                    {t(provider.configured ? 'voiceSettings.configured' : 'voiceSettings.notConfigured')}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t('voiceSettings.privacy', { seconds: voice.config.maxDurationSeconds })}</p>
            {voice.config.providers.some((provider) => provider.id === 'mai-transcribe' && !provider.configured) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('voiceSettings.maiSetup')}</p>
            )}
          </div>
        )}
        {!voice.config && <p className="text-sm text-muted-foreground" role="status">{t(voice.error ? 'voiceSettings.loadFailed' : 'voiceSettings.loading')}</p>}
        <button type="button" onClick={voice.refresh} className="mt-3 rounded border border-border px-3 py-1.5 text-xs">
          {t('voiceSettings.refresh')}
        </button>
      </SettingsSection>
    </div>
  );
}
