import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import { CodeyVoiceSelectors } from '@/shared/ui/CodeyVoiceSelectors';
import type { CodeyVoiceConfig, CodeyVoicePreferences, VoiceInputState } from '@/shared/types';

type Props = {
  state: VoiceInputState;
  disabled: boolean;
  onToggle: () => void;
  onCancel: () => void;
  managed?: {
    config: CodeyVoiceConfig | null;
    preferences: CodeyVoicePreferences;
    onChange: (patch: Partial<CodeyVoicePreferences>) => void;
    onRefresh: () => void;
    loadFailed: boolean;
  };
};

/** ChatComposer supplies recording state; this split control exposes options without opening the microphone. */
export function ComposerVoiceControl({ state, disabled, onToggle, onCancel, managed }: Props) {
  const { t } = useTranslation(['chat', 'settings']);
  // Opening voice options is independent of the microphone's capture lifecycle.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 288, 'start');
  const provider = managed?.config?.providers.find((item) => item.id === managed.preferences.provider);
  const language = managed?.preferences.language === 'auto'
    ? t('voiceSettings.autoLanguage', { ns: 'settings' })
    : managed?.preferences.language === 'zh-CN' ? '中文' : 'English';
  const summary = managed && provider ? `${provider.label} · ${language}` : undefined;
  const label = t('voice.options');
  const busy = state !== 'idle';

  return (
    <div className="inline-flex shrink-0 items-center rounded-lg" role="group" aria-label={t('voice.input')}>
      <VoiceInputButton state={state} disabled={disabled} onToggle={onToggle} onCancel={onCancel} contextLabel={summary} />
      {managed && (
        <PromptInputButton ref={triggerRef} aria-label={label} title={summary ? `${label} · ${summary}` : label}
          aria-haspopup="dialog" aria-expanded={isOpen}
          className={`w-5 rounded-l-none text-muted-foreground [&_svg]:size-3 ${isOpen ? 'bg-accent text-foreground' : ''}`}
          onClick={() => { updateAnchor(); setIsOpen((value) => !value); }}>
          <ChevronDown />
        </PromptInputButton>
      )}
      {managed && isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={label} role="dialog">
          <div className="space-y-4 p-3">
            <div>
              <h3 className="text-sm font-semibold">{label}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('voice.optionsHint')}</p>
            </div>
            {managed.config ? (
              <CodeyVoiceSelectors layout="stacked" config={managed.config} preferences={managed.preferences}
                onChange={managed.onChange} disabled={busy} />
            ) : (
              <p role="status" className="text-xs text-muted-foreground">
                {t(managed.loadFailed ? 'voiceSettings.loadFailed' : 'voiceSettings.loading', { ns: 'settings' })}
              </p>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-xs text-muted-foreground">
                {busy ? t('voice.optionsLocked') : t('voice.optionsLimit', { seconds: managed.config?.maxDurationSeconds || 120 })}
              </span>
              <button type="button" onClick={managed.onRefresh} disabled={busy}
                aria-label={t('voiceSettings.refresh', { ns: 'settings' })}
                title={t('voiceSettings.refresh', { ns: 'settings' })}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-40">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </ComposerMenuSurface>, document.body,
      )}
    </div>
  );
}
