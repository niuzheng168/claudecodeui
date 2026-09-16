import { useCallback, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePenLine, Loader2, Redo2, RefreshCw, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import type { VoiceRewriteResult } from '@/shared/types';

type Props = {
  busy: boolean;
  canRewrite: boolean;
  canUndo: boolean;
  canRestore: boolean;
  hasPreviousRewrite: boolean;
  configured: boolean;
  originalText?: string;
  notice?: string;
  candidate?: VoiceRewriteResult;
  canApply?: boolean;
  needsAttention?: boolean;
  onRewrite: () => void;
  onCancel: () => void;
  onUndo: () => void;
  onRestore: () => void;
  onApply?: () => void;
};

/** ChatComposer and its visual fixture keep rewrite details off the input area, behind this manual menu. */
export function VoiceRewriteControl({
  busy, canRewrite, canUndo, canRestore, hasPreviousRewrite, configured,
  originalText, notice, candidate, canApply = false, needsAttention = false,
  onRewrite, onCancel, onUndo, onRestore, onApply,
}: Props) {
  const { t } = useTranslation('chat');
  const statusId = useId();
  // Details open only on demand; receiving a result or editing a draft never expands the composer.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const hasDetails = Boolean(originalText || notice || candidate);
  // An edited draft disables replacement actions, not read-only access to its original voice text.
  const canChoose = !busy && (hasDetails || (hasPreviousRewrite && (canRewrite || canRestore)));
  const menuOpen = isOpen && canChoose;
  const popupRole = hasDetails ? 'dialog' : 'menu';
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(menuOpen, close, 288, 'start');
  // Do not reopen an old menu after recording or clearing the draft's voice snapshot.
  if (isOpen && !canChoose) setIsOpen(false);
  const select = (action: () => void) => {
    close();
    triggerRef.current?.focus({ preventScroll: true });
    action();
  };
  const label = t(busy ? 'voice.rewrite.cancel' : 'voice.rewrite.action');
  const hint = busy ? label : t(canChoose ? 'voice.rewrite.optionsHint'
    : !configured ? 'voice.rewrite.notConfigured' : !canRewrite ? 'voice.rewrite.recordFirst' : 'voice.rewrite.hint');
  const status = busy ? t('voice.rewrite.busy') : notice
    ? t(`voice.rewrite.${notice}`, { defaultValue: t('voice.rewrite.failed') }) : '';
  const title = status ? `${hint}\n${status}` : hint;
  return (
    <div className="inline-flex shrink-0 items-center" role="group" aria-label={t('voice.rewrite.group')}>
      <span id={statusId} role="status" className="sr-only">{status}</span>
      <span title={title} className="relative inline-flex">
        <PromptInputButton ref={triggerRef} aria-label={label} title={title}
          aria-describedby={status ? statusId : undefined} disabled={!busy && !canRewrite && !canRestore && !hasDetails}
          aria-haspopup={canChoose ? popupRole : undefined} aria-expanded={canChoose ? menuOpen : undefined}
          onClick={() => {
            if (busy) onCancel();
            else if (canChoose) { updateAnchor(); setIsOpen((value) => !value); }
            else onRewrite();
          }} className={menuOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}>
          {busy ? <Loader2 className="animate-spin" /> : <FilePenLine />}
        </PromptInputButton>
        {!busy && needsAttention && (
          <span aria-hidden data-slot="voice-rewrite-attention"
            className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
        )}
      </span>
      {canUndo && (
        <PromptInputButton aria-label={t('voice.rewrite.undo')} title={t('voice.rewrite.undo')}
          onClick={() => select(onUndo)} className="text-muted-foreground">
          <Undo2 />
        </PromptInputButton>
      )}
      {canRestore && (
        <PromptInputButton aria-label={t('voice.rewrite.restore')} title={t('voice.rewrite.restoreHint')}
          onClick={() => select(onRestore)} className="text-muted-foreground">
          <Redo2 />
        </PromptInputButton>
      )}
      {menuOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={t('voice.rewrite.options')} role={popupRole}>
          <div className="flex items-center justify-between">
            <ComposerMenuHeading>{t('voice.rewrite.options')}</ComposerMenuHeading>
            {hasDetails && (
              <PromptInputButton aria-label={t('voice.rewrite.close')} title={t('voice.rewrite.close')}
                onClick={() => {
                  close();
                  triggerRef.current?.focus({ preventScroll: true });
                }} className="text-muted-foreground">
                <X aria-hidden />
              </PromptInputButton>
            )}
          </div>
          {hasDetails && (
            <div className="space-y-2 border-b border-border px-2.5 pb-2 text-xs leading-5 text-muted-foreground">
              {status && <p>{status}</p>}
              {originalText && (
                <details>
                  <summary className="cursor-pointer rounded py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t('voice.rewrite.original')}
                  </summary>
                  <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-foreground">{originalText}</p>
                </details>
              )}
              {candidate && (
                <>
                  <textarea readOnly aria-label={t('voice.rewrite.suggestion')} value={candidate.text}
                    className="w-full resize-y rounded border border-border bg-background p-2 text-foreground" rows={3} />
                  {canApply && onApply ? (
                    <button type="button" className="min-h-9 rounded border border-border px-2 py-1 text-foreground"
                      onClick={() => select(onApply)}>{t('voice.rewrite.apply')}</button>
                  ) : <p>{t('voice.rewrite.copySuggestion')}</p>}
                </>
              )}
            </div>
          )}
          {hasPreviousRewrite && (
            <ComposerMenuItem role={hasDetails ? 'button' : 'menuitem'}
              label={t('voice.rewrite.restore')} description={t('voice.rewrite.restoreHint')}
              icon={<Redo2 className="h-4 w-4" />} isSelected={false} disabled={!canRestore}
              onSelect={() => select(onRestore)} />
          )}
          <ComposerMenuItem role={hasDetails ? 'button' : 'menuitem'}
            label={t(hasPreviousRewrite ? 'voice.rewrite.regenerate' : 'voice.rewrite.action')}
            description={t(hasPreviousRewrite ? 'voice.rewrite.regenerateHint' : 'voice.rewrite.hint')}
            icon={<RefreshCw className="h-4 w-4" />} isSelected={false} disabled={!canRewrite}
            onSelect={() => select(onRewrite)} />
        </ComposerMenuSurface>, document.body,
      )}
    </div>
  );
}
