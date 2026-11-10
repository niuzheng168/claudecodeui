import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { MonitorIcon, UserRoundIcon } from 'lucide-react';

import type { MessageSender } from '@/shared/types';
import { TranscriptViewerContext } from '@/modules/chat/context/TranscriptViewerContext';

type SenderLabel = {
  text: string;
  /** Another person wrote it, as opposed to the reader or one of the owner's own sessions. */
  isOtherPerson: boolean;
  isMachine: boolean;
};

/**
 * What a user turn's badge says.
 *
 * An envelope names its sender: another user, a session on one of the owner's
 * machines, or the owner through the Codey API (no address, no machine). A
 * turn without one is the owner's own, which needs saying only to a reader
 * who is not the owner — the shared-session page.
 */
function describeSender(
  sender: MessageSender | undefined,
  viewer: { ownerName: string; viewerName: string | null } | null,
  t: TFunction,
): SenderLabel | null {
  if (!sender) {
    return viewer
      ? { text: t('message.sender.owner', { user: viewer.ownerName, defaultValue: '{{user}}' }), isOtherPerson: true, isMachine: false }
      : null;
  }
  if (sender.user) {
    if (viewer?.viewerName && sender.user === viewer.viewerName) {
      return { text: t('message.sender.me', { defaultValue: 'Me' }), isOtherPerson: false, isMachine: false };
    }
    return {
      text: t('message.sender.fromUser', { user: sender.user, defaultValue: 'From {{user}}' }),
      isOtherPerson: true,
      isMachine: false,
    };
  }
  if (sender.machine) {
    return {
      text: t('message.sender.fromMachine', { machine: sender.machine, defaultValue: 'From a session on {{machine}}' }),
      isOtherPerson: false,
      isMachine: true,
    };
  }
  return sender.address
    ? { text: t('message.sender.fromSession', { defaultValue: 'From another session' }), isOtherPerson: false, isMachine: true }
    : { text: t('message.sender.fromApi', { defaultValue: 'Sent through the Codey API' }), isOtherPerson: false, isMachine: true };
}

/**
 * Rendered by chat's MessageComponent above a user bubble to say who wrote the
 * turn when it was not simply the person reading: another Codey user, another
 * session, or — on a shared session's page — the owner or the reader.
 */
export default function MessageSenderBadge({ sender }: { sender: MessageSender | undefined }) {
  const { t } = useTranslation('chat');
  const viewer = useContext(TranscriptViewerContext);
  const label = describeSender(sender, viewer, t);
  if (!label) {
    return null;
  }

  const Icon = label.isMachine ? MonitorIcon : UserRoundIcon;
  const details = [sender?.address, sender?.agent].filter(Boolean).join(' · ');

  return (
    <div
      data-testid="message-sender"
      title={details || undefined}
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
        label.isOtherPerson
          ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/60 dark:bg-blue-900/30 dark:text-blue-300'
          : 'border-border/60 bg-muted/60 text-muted-foreground'
      }`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{label.text}</span>
    </div>
  );
}
