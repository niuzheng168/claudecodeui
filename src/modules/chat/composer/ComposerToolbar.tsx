import type { ReactNode } from 'react';
import { PaperclipIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PromptInputButton, PromptInputFooter, PromptInputTools } from '@/modules/chat/composer/PromptInput';
import { ComposerToolsMenu } from '@/modules/chat/composer/ComposerToolsMenu';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

type Props = {
  onAttachFiles: () => void;
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

/** ChatComposer uses this two-level toolbar to keep primary actions visible and secondary settings out of the typing row. */
export function ComposerToolbar({
  onAttachFiles, voiceControl, rewriteControl, rewriteNotice, modelControl, permissionControl, submitControl,
  tokenUsage, onShowTokenUsage, commandsCount, onShowCommands, hasInput, onClearInput,
  canSchedule, onSchedule, submitHint, hideHint, voiceStatus, voiceError,
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
      <div className="composer-primary flex min-w-0 items-center gap-1.5" data-slot="composer-primary">
        <PromptInputTools className="shrink-0 gap-0.5">
          <PromptInputButton tooltip={{ content: t('input.attachFiles') }} aria-label={t('input.attachFiles')}
            onClick={onAttachFiles} className="text-muted-foreground">
            <PaperclipIcon />
          </PromptInputButton>
          {voiceControl}
          {rewriteControl}
          <ComposerToolsMenu commandsCount={commandsCount} onShowCommands={onShowCommands}
            hasInput={hasInput} onClearInput={onClearInput} canSchedule={canSchedule} onSchedule={onSchedule} />
        </PromptInputTools>
        <div className="composer-actions ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {modelControl}
          {permissionControl}
          {submitControl}
        </div>
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
      </div>
    </PromptInputFooter>
  );
}
