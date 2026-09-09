import { useTranslation } from 'react-i18next';
import { Loader2, PencilIcon, XIcon, ZapIcon } from 'lucide-react';

type QueuedMessageCardProps = {
  content: string;
  attachmentCount?: number;
  onEdit: () => void;
  onDelete: () => void;
  onSteer?: () => void;
  canSteer?: boolean;
  steerUnavailableReason?: string | null;
  isSteering?: boolean;
  steerError?: string | null;
  held?: boolean;
};

/**
 * Rendered by chat's ChatComposer to show the message queued for a busy
 * session, with immediate append, edit and delete actions before it is auto-sent.
 */
export default function QueuedMessageCard({
  content,
  attachmentCount = 0,
  onEdit,
  onDelete,
  onSteer,
  canSteer = false,
  steerUnavailableReason,
  isSteering = false,
  steerError,
  held = false,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');

  return (
    <div data-slot="queued-message" className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2" aria-busy={isSteering}>
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            <span className="shrink-0">{held ? t('input.queue.review') : t('input.queue.label', { defaultValue: 'Queued' })}</span>
            <span className="truncate normal-case text-muted-foreground/60">
              · {isSteering ? t('input.steer.sending') : held ? t('input.queue.paused') : t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{content}</p>
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {attachmentCount} {attachmentCount === 1 ? 'file' : 'files'} attached
            </p>
          )}
        </div>

        <div data-slot="queued-message-actions" className="flex shrink-0 items-center gap-0.5">
          {onSteer && (
            <button
              type="button"
              onClick={onSteer}
              disabled={!canSteer || isSteering || held}
              aria-label={t(isSteering ? 'input.steer.sending' : 'input.steer.send')}
              title={held ? t('input.queue.reviewHint') : !canSteer
                ? steerUnavailableReason || t('input.steer.unavailable') : t('input.steer.description')}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md p-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSteering ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <ZapIcon aria-hidden className="h-3.5 w-3.5" />}
              {t('input.steer.send')}
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            disabled={isSteering}
            aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isSteering}
            aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {(steerError || held) && (
        <p role="alert" className="mt-1 break-words text-xs text-destructive">
          {held ? t('input.queue.reviewHint') : `${t('input.steer.failed')}: ${steerError}`}
        </p>
      )}
    </div>
  );
}
