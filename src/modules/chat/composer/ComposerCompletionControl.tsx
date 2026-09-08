import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import type { ComposerPreferences } from '@/shared/types';

type Props = {
  configured: boolean;
  ready: boolean;
  preferences: ComposerPreferences;
  onPreferenceChange: (patch: Partial<ComposerPreferences>) => void;
};

/** ChatComposer keeps completion consent in the toolbar without reserving a separate input row. */
export function ComposerCompletionControl({ configured, ready, preferences, onPreferenceChange }: Props) {
  const { t } = useTranslation('chat');
  // Settings open independently of suggestions and never expand the composer.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 320, 'start');
  const label = t('completion.title');
  const status = t(preferences.completionEnabled ? 'completion.on' : 'completion.off');

  return (
    <>
      <PromptInputButton ref={triggerRef} data-completion-controls
        aria-label={`${label} · ${status}`} title={`${label} · ${status}`}
        aria-haspopup="dialog" aria-expanded={isOpen}
        className={preferences.completionEnabled
          ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
          : isOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}
        onClick={() => { updateAnchor(); setIsOpen((value) => !value); }}>
        <Sparkles aria-hidden="true" />
      </PromptInputButton>
      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={label} role="dialog">
          <div data-completion-controls className="space-y-2 p-3 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">{label}</h3>
              <span>{status}</span>
            </div>
            <p className="leading-5">{t('completion.consent')}</p>
            <label className="flex min-h-11 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={preferences.completionEnabled}
                disabled={!ready || (!configured && !preferences.completionEnabled)}
                onChange={(event) => onPreferenceChange({ completionEnabled: event.target.checked })} />
              {t('completion.enable')}
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={preferences.useHistory} disabled={!ready}
                onChange={(event) => onPreferenceChange({ useHistory: event.target.checked })} />
              {t('completion.history')}
            </label>
            {!configured && <p>{t('completion.notConfigured')}</p>}
          </div>
        </ComposerMenuSurface>, document.body,
      )}
    </>
  );
}
