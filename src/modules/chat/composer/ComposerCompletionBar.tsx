import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Undo2, X } from 'lucide-react';

import type { ComposerCompletionCandidate, ComposerPreferences } from '@/shared/types';

type Props = {
  candidate: ComposerCompletionCandidate | null;
  ghostVisible: boolean;
  configured: boolean;
  ready: boolean;
  preferences: ComposerPreferences;
  phase: string;
  notice: 'applied' | 'undone' | null;
  canUndo: boolean;
  onPreferenceChange: (patch: Partial<ComposerPreferences>) => void;
  onAccept: () => void;
  onDismiss: () => void;
  onUndo: () => void;
};

/** ChatComposer's explicit opt-in and touch-safe candidate controls never submit the surrounding form. */
export function ComposerCompletionBar({
  candidate, ghostVisible, configured, ready, preferences, phase, notice, canUndo,
  onPreferenceChange, onAccept, onDismiss, onUndo,
}: Props) {
  const { t } = useTranslation('chat');
  const suggestionId = useId();
  return (
    <div data-completion-controls className="px-3 pb-2">
      <details className="text-xs text-muted-foreground">
        <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-primary">
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
          {t('completion.title')}
          <span>{preferences.completionEnabled ? t('completion.on') : t('completion.off')}</span>
        </summary>
        <div className="mb-2 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <p>{t('completion.consent')}</p>
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
      </details>
      {candidate && (
        <div className="flex items-center gap-1 rounded-lg bg-muted/50 pl-3">
          <p id={suggestionId} className={ghostVisible
            ? 'sr-only' : 'min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-muted-foreground'}>
            {candidate.suffix}
          </p>
          {ghostVisible && <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t('completion.hint')}</span>}
          <button type="button" aria-describedby={suggestionId}
            className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-primary hover:bg-muted focus-visible:outline focus-visible:outline-primary"
            onPointerDown={(event) => event.preventDefault()} onClick={onAccept}>
            {t('completion.accept')} ↹
          </button>
          <button type="button" aria-label={t('completion.dismiss')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-primary"
            onPointerDown={(event) => event.preventDefault()} onClick={onDismiss}>
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      )}
      <span role="status" aria-live="polite" className="sr-only">{candidate ? t('completion.ready') : ''}</span>
      {canUndo && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('completion.applied')}</span>
          <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onUndo}
            className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-primary hover:bg-muted">
            <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />{t('completion.undo')}
          </button>
        </div>
      )}
      {!candidate && !canUndo && preferences.completionEnabled && ['requesting', 'cooldown', 'unavailable'].includes(phase) && (
        <p className="py-1 text-xs text-muted-foreground">{t(`completion.${phase}`)}</p>
      )}
      {notice === 'undone' && <span role="status" className="sr-only">{t('completion.undone')}</span>}
    </div>
  );
}
