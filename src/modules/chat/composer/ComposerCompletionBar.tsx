import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Undo2, X } from 'lucide-react';

import type { ComposerCompletionCandidate, ComposerPreferences } from '@/shared/types';

type Props = {
  candidate: ComposerCompletionCandidate | null;
  ghostVisible: boolean;
  preferences: ComposerPreferences;
  phase: string;
  notice: 'applied' | 'undone' | null;
  canUndo: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onUndo: () => void;
};

/** ChatComposer shows touch-safe candidate actions only when needed; the live announcement stays mounted. */
export function ComposerCompletionBar({
  candidate, ghostVisible, preferences, phase, notice, canUndo, onAccept, onDismiss, onUndo,
}: Props) {
  const { t } = useTranslation('chat');
  const suggestionId = useId();
  const showPhase = !candidate && !canUndo && preferences.completionEnabled
    && ['requesting', 'cooldown', 'unavailable'].includes(phase);
  return (
    <>
      {(candidate || canUndo || showPhase) && (
        <div data-completion-controls className="px-3 pb-2">
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
          {canUndo && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('completion.applied')}</span>
              <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={onUndo}
                className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-primary hover:bg-muted">
                <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />{t('completion.undo')}
              </button>
            </div>
          )}
          {showPhase && (
            <p className="py-1 text-xs text-muted-foreground">{t(`completion.${phase}`)}</p>
          )}
        </div>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {candidate ? t('completion.ready') : notice === 'undone' ? t('completion.undone') : ''}
      </span>
    </>
  );
}
