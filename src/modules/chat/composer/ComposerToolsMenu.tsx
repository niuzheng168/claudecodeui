import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, Clock, Ellipsis, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { ComposerMenuHeading, ComposerMenuItem, ComposerMenuSeparator, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import { ScheduleMessagePicker } from '@/modules/chat/composer/ScheduleMessagePicker';

type Props = {
  commandsCount: number;
  onShowCommands: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  canSchedule: boolean;
  onSchedule: (date: Date) => void;
};

/** Chat's ComposerToolbar groups less frequent draft actions here, without hiding send or permissions. */
export function ComposerToolsMenu({ commandsCount, onShowCommands, hasInput, onClearInput, canSchedule, onSchedule }: Props) {
  const { t } = useTranslation('chat');
  // Secondary actions are disclosed only when requested, not on every keystroke.
  const [isOpen, setIsOpen] = useState(false);
  // The scheduler shares this surface so portalled child clicks cannot dismiss their parent.
  const [view, setView] = useState<'tools' | 'schedule'>('tools');
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(
    isOpen, close, view === 'schedule' ? 320 : 264, 'start',
  );
  const select = (action: () => void) => {
    close();
    triggerRef.current?.focus();
    action();
  };
  const label = t('composer.moreTools');

  return (
    <>
      <PromptInputButton ref={triggerRef} aria-label={label} title={label} aria-haspopup="menu"
        aria-expanded={isOpen} className={isOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}
        onClick={() => { updateAnchor(); setView('tools'); setIsOpen((value) => !value); }}>
        <Ellipsis />
      </PromptInputButton>
      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={view === 'schedule' ? t('schedule.heading') : label}
          role={view === 'schedule' ? 'dialog' : 'menu'}>
          {view === 'tools' ? (
            <>
              <ComposerMenuHeading>{label}</ComposerMenuHeading>
              <ComposerMenuItem role="menuitem" label={t('input.showAllCommands')} isSelected={false}
                icon={<span aria-hidden="true" className="font-mono font-medium">/</span>}
                trailing={commandsCount > 0 ? <span className="text-xs text-muted-foreground">{commandsCount}</span> : undefined}
                onSelect={() => select(onShowCommands)} />
              <ComposerMenuItem role="menuitem" label={t('schedule.trigger')} isSelected={false}
                icon={<Clock className="h-4 w-4" />} trailing={<ChevronRight className="h-3 w-3" />}
                disabled={!canSchedule} description={!canSchedule ? t('composer.writeFirst') : undefined}
                onSelect={() => setView('schedule')} />
              <ComposerMenuSeparator />
              <ComposerMenuItem role="menuitem" label={t('input.clearInput')} isSelected={false}
                icon={<Trash2 className="h-4 w-4" />} disabled={!hasInput}
                onSelect={() => select(onClearInput)} />
            </>
          ) : (
            <>
              <button type="button" className="flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs text-muted-foreground hover:bg-accent"
                onClick={() => setView('tools')}>
                <ArrowLeft className="h-3.5 w-3.5" />{t('composer.backToTools')}
              </button>
              <ScheduleMessagePicker disabled={!canSchedule} onSchedule={(date) => select(() => onSchedule(date))} />
            </>
          )}
        </ComposerMenuSurface>, document.body,
      )}
    </>
  );
}
