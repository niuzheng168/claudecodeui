import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { SessionTakeOverPrompt } from '@/shared/types';

type SessionTakeOverDialogProps = {
  prompt: SessionTakeOverPrompt | null;
  onResolve: (confirmed: boolean) => void;
};

/**
 * Rendered by chat's ChatComposer when the node refused a Claude turn because
 * another Claude Code process, such as `claude` in a terminal, has the session
 * open. Two processes continuing one
 * session would split the conversation, so sending here ends that process;
 * the choices are to do that and resend, or keep it running.
 *
 * Cancel comes first in the DOM so Dialog's open-focus lands on it: an Enter
 * pressed right after the send cannot end the terminal's process. Esc and a
 * click outside also cancel.
 */
export default function SessionTakeOverDialog({ prompt, onResolve }: SessionTakeOverDialogProps) {
  const { t } = useTranslation('chat');

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) {
          onResolve(false);
        }
      }}
    >
      <DialogContent aria-describedby="session-take-over-dialog-description" className="p-5">
        <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
          {t('claudeStatus.sessionOpenElsewhere.title', {
            defaultValue: 'This session is open in another Claude Code process',
          })}
        </DialogTitle>

        <p id="session-take-over-dialog-description" className="mt-3 text-sm text-muted-foreground">
          {t('claudeStatus.sessionOpenElsewhere.description', {
            pid: prompt?.pid,
            entrypoint: prompt?.entrypoint,
            defaultValue: 'Claude Code ({{entrypoint}}, process {{pid}}) on this machine has this session open, for example `claude` in a terminal. Sending from here ends that process; `claude --resume` continues the session there later. Two processes continuing one session would split the conversation.',
          })}
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onResolve(false)}>
            {t('claudeStatus.sessionOpenElsewhere.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="button" variant="destructive" onClick={() => onResolve(true)}>
            {t('claudeStatus.sessionOpenElsewhere.confirm', { defaultValue: 'End it and send' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
