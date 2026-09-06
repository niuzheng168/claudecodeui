import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePenLine, Loader2, Redo2, RefreshCw, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';

type Props = {
  busy: boolean;
  canRewrite: boolean;
  canUndo: boolean;
  canRestore: boolean;
  hasPreviousRewrite: boolean;
  configured: boolean;
  onRewrite: () => void;
  onCancel: () => void;
  onUndo: () => void;
  onRestore: () => void;
};

/** ChatComposer and its visual fixture use this manual rewrite menu and local undo/restore beside the mic. */
export function VoiceRewriteControl({
  busy, canRewrite, canUndo, canRestore, hasPreviousRewrite, configured,
  onRewrite, onCancel, onUndo, onRestore,
}: Props) {
  const { t } = useTranslation('chat');
  // A saved result turns the rewrite action into an explicit local-restore/regenerate choice.
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const canChoose = hasPreviousRewrite && !busy && (canRewrite || canRestore);
  const menuOpen = isOpen && canChoose;
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(menuOpen, close, 288, 'start');
  // Do not reopen an old menu after recording, editing, or changing the draft's scope.
  if (isOpen && !canChoose) setIsOpen(false);
  const select = (action: () => void) => {
    close();
    triggerRef.current?.focus();
    action();
  };
  const label = t(busy ? 'voice.rewrite.cancel' : 'voice.rewrite.action');
  const hint = busy ? label : t(canChoose ? 'voice.rewrite.optionsHint'
    : !configured ? 'voice.rewrite.notConfigured' : !canRewrite ? 'voice.rewrite.recordFirst' : 'voice.rewrite.hint');
  return (
    <div className="inline-flex shrink-0 items-center" role="group" aria-label={t('voice.rewrite.group')}>
      <span title={hint}>
        <PromptInputButton ref={triggerRef} aria-label={label} title={hint} disabled={!busy && !canRewrite && !canRestore}
          aria-haspopup={canChoose ? 'menu' : undefined} aria-expanded={canChoose ? menuOpen : undefined}
          onClick={() => {
            if (busy) onCancel();
            else if (canChoose) { updateAnchor(); setIsOpen((value) => !value); }
            else onRewrite();
          }} className={menuOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}>
          {busy ? <Loader2 className="animate-spin" /> : <FilePenLine />}
        </PromptInputButton>
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
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={t('voice.rewrite.options')}>
          <ComposerMenuHeading>{t('voice.rewrite.options')}</ComposerMenuHeading>
          <ComposerMenuItem role="menuitem" label={t('voice.rewrite.restore')} description={t('voice.rewrite.restoreHint')}
            icon={<Redo2 className="h-4 w-4" />} isSelected={false} disabled={!canRestore}
            onSelect={() => select(onRestore)} />
          <ComposerMenuItem role="menuitem" label={t('voice.rewrite.regenerate')} description={t('voice.rewrite.regenerateHint')}
            icon={<RefreshCw className="h-4 w-4" />} isSelected={false} disabled={!canRewrite}
            onSelect={() => select(onRewrite)} />
        </ComposerMenuSurface>, document.body,
      )}
    </div>
  );
}
