import type { FocusEvent, ReactNode } from 'react';
import { PaperclipIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PromptInputButton, PromptInputFooter, PromptInputTools } from '@/modules/chat/composer/PromptInput';
import { ComposerToolsMenu } from '@/modules/chat/composer/ComposerToolsMenu';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

type Props = {
  onAttachFiles: () => void;
  collapseControl?: ReactNode;
  completionControl?: ReactNode;
  voiceControl?: ReactNode;
  rewriteControl?: ReactNode;
  rewriteNotice?: ReactNode;
  modelControl: ReactNode;
  permissionControl: ReactNode;
  submitControl: ReactNode;
  tokenUsage: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  commandsCount: number;
  onShowCommands: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  canSchedule: boolean;
  onSchedule: (date: Date) => void;
  submitHint: string;
  hideHint: boolean;
  voiceStatus?: string;
  voiceError?: string | null;
};

function revealFocusedTool({ currentTarget, target }: FocusEvent<HTMLDivElement>) {
  // Portalled menus also bubble React focus events here, but must never scroll the tool strip.
  if (!currentTarget.contains(target) || currentTarget.scrollWidth <= currentTarget.clientWidth) return;
  const strip = currentTarget.getBoundingClientRect();
  const tool = target.getBoundingClientRect();
  // Native focus scrolling can leave partially visible buttons clipped; include their 2px focus ring.
  const left = tool.left - strip.left - 2;
  const right = tool.right - strip.right + 2;
  if (left < 0) currentTarget.scrollLeft += left;
  else if (right > 0) currentTarget.scrollLeft += right;
}

/** ChatComposer keeps primary actions on one line, with secondary status below and scrollable tools on narrow panes. */
export function ComposerToolbar({
  onAttachFiles, completionControl, voiceControl, rewriteControl, rewriteNotice, modelControl, permissionControl, submitControl,
  tokenUsage, onShowTokenUsage, commandsCount, onShowCommands, hasInput, onClearInput,
  canSchedule, onSchedule, submitHint, hideHint, voiceStatus, voiceError, collapseControl,
}: Props) {
  const { t } = useTranslation('chat');
  return (
    <PromptInputFooter className="composer-toolbar block px-2.5 pb-1.5 pt-2 sm:px-3">
      {voiceError && (
        <p role="alert" className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-700 dark:text-red-300">
          {voiceError}
        </p>
      )}
      {rewriteNotice}
      <div className="composer-primary flex min-w-0 flex-nowrap items-center gap-1" data-slot="composer-primary">
        {/* Only tools may scroll: model, permissions and send must stay visible without shrinking the icon buttons. */}
        <PromptInputTools onFocusCapture={revealFocusedTool}
          className="-my-1 -ml-0.5 mr-auto min-w-0 shrink gap-px overflow-x-auto overscroll-x-contain px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
          <PromptInputButton tooltip={{ content: t('input.attachFiles') }} aria-label={t('input.attachFiles')}
            onClick={onAttachFiles} className="text-muted-foreground">
            <PaperclipIcon />
          </PromptInputButton>
          {completionControl}
          {voiceControl}
          {rewriteControl}
          <ComposerToolsMenu commandsCount={commandsCount} onShowCommands={onShowCommands}
            hasInput={hasInput} onClearInput={onClearInput} canSchedule={canSchedule} onSchedule={onSchedule} />
        </PromptInputTools>
        {modelControl}
        {permissionControl}
        {submitControl}
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-3 px-1" data-slot="composer-status">
        <TokenUsageSummary usage={tokenUsage} onClick={onShowTokenUsage} />
        {voiceStatus ? (
          <span aria-hidden="true" className="min-w-0 truncate text-[11px] text-primary">{voiceStatus}</span>
        ) : (
          <span className={`composer-shortcut-hint min-w-0 truncate text-right text-[11px] text-muted-foreground ${hideHint ? 'invisible' : ''}`}>
            {submitHint}
          </span>
        )}
        {collapseControl}
      </div>
    </PromptInputFooter>
  );
}
