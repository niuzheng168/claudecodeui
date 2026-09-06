import { useTranslation } from 'react-i18next';

import type { CodeyVoiceConfig, CodeyVoiceLanguage, CodeyVoicePreferences, CodeyVoiceProvider } from '@/shared/types';

type Props = {
  config: CodeyVoiceConfig;
  preferences: CodeyVoicePreferences;
  onChange: (patch: Partial<CodeyVoicePreferences>) => void;
  disabled?: boolean;
  layout?: 'columns' | 'stacked';
};

/** Chat and Settings share these credential-free provider/language selectors. */
export function CodeyVoiceSelectors({ config, preferences, onChange, disabled = false, layout = 'columns' }: Props) {
  const { t } = useTranslation('settings');
  const classes = 'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground';
  return (
    <div className={layout === 'stacked' ? 'grid gap-3' : 'grid gap-4 sm:grid-cols-2'}>
      <label className="min-w-0 space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground">{t('voiceSettings.provider')}</span>
        <select className={classes} aria-label={t('voiceSettings.provider')} disabled={disabled}
          value={preferences.provider} onChange={(event) => onChange({ provider: event.target.value as CodeyVoiceProvider })}>
          {config.providers.map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!provider.configured}>
              {provider.label}{provider.configured ? '' : ` (${t('voiceSettings.notConfigured')})`}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0 space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground">{t('voiceSettings.language')}</span>
        <select className={classes} aria-label={t('voiceSettings.language')} disabled={disabled}
          value={preferences.language} onChange={(event) => onChange({ language: event.target.value as CodeyVoiceLanguage })}>
          {config.languages.map((language) => (
            <option key={language} value={language}>
              {language === 'auto' ? t('voiceSettings.autoLanguage') : language === 'zh-CN' ? '中文' : 'English'}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
