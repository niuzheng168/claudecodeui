import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircleIcon, CheckIcon, ClockIcon, XIcon } from 'lucide-react';

import type { ChatMessage, SharedSessionOutgoingMessage } from '@/shared/types';

/** Statuses of a message that has not reached the session yet. */
const WAITING_STATUSES = new Set(['awaiting_confirmation', 'pending']);
/** Delivered to the session's queue; the Portal is never told when it leaves it. */
const QUEUED_STATUS = 'queued';
/** Handed to the agent: the transcript shows it within seconds. */
const DELIVERED_STATUSES = new Set(['started', 'handed_off']);
const FAILED_STATUSES = new Set(['declined', 'failed', 'expired']);
/** A delivered message the transcript never matched (an edited echo, a turn it was folded into) stops being listed after this. */
const DELIVERED_VISIBLE_MS = 10 * 60_000;
/** How long a message that did not get through stays listed. */
const FAILED_VISIBLE_MS = 24 * 60 * 60_000;
/** Clock difference tolerated between the Portal (`createdAt`) and the owner's machine (transcript timestamps). */
const CLOCK_SKEW_MS = 5 * 60_000;
/** Time-based visibility is re-evaluated this often even when nothing else re-renders. */
const CLOCK_TICK_MS = 30_000;

const normalizeText = (value: unknown): string => String(value ?? '').replace(/\r\n/g, '\n').trim();

const readTime = (value: unknown): number => {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : Number.NaN;
};

/**
 * The viewer's messages still worth listing under the transcript, oldest first.
 *
 * A message stops being listed once the transcript shows it: a user turn whose
 * envelope names the viewer and whose body is the message's text, written no
 * earlier than the message. Each such turn accounts for one message, so the
 * same text sent twice needs two turns. A queued or delivered message older
 * than the oldest loaded row is not listed either — it is somewhere in the
 * history not loaded yet, not waiting.
 */
function selectOutboxMessages({
  messages,
  chatMessages,
  viewerName,
  hasEarlierHistory,
  dismissedIds,
  now,
}: {
  messages: SharedSessionOutgoingMessage[];
  chatMessages: ChatMessage[];
  viewerName: string | null;
  hasEarlierHistory: boolean;
  dismissedIds: Set<string>;
  now: number;
}): SharedSessionOutgoingMessage[] {
  const shownTurns = chatMessages
    .filter((message) => message.type === 'user' && message.sender && (!viewerName || message.sender.user === viewerName))
    .map((message) => ({ text: normalizeText(message.content), time: readTime(message.timestamp), claimed: false }));
  const oldestLoadedTime = hasEarlierHistory && chatMessages.length > 0
    ? readTime(chatMessages[0].timestamp)
    : Number.NaN;

  const oldestFirst = [...messages].sort((left, right) => (readTime(left.createdAt) || 0) - (readTime(right.createdAt) || 0));
  const listed: SharedSessionOutgoingMessage[] = [];
  for (const message of oldestFirst) {
    const createdAt = readTime(message.createdAt);
    if (FAILED_STATUSES.has(message.status)) {
      if (!dismissedIds.has(message.id) && !(now - createdAt > FAILED_VISIBLE_MS)) {
        listed.push(message);
      }
      continue;
    }

    const text = normalizeText(message.text);
    const shownTurn = shownTurns.find((turn) => !turn.claimed && turn.text === text
      && !(turn.time < createdAt - CLOCK_SKEW_MS));
    if (shownTurn) {
      shownTurn.claimed = true;
      continue;
    }

    if (WAITING_STATUSES.has(message.status)) {
      listed.push(message);
      continue;
    }
    const beforeLoadedHistory = createdAt < oldestLoadedTime - CLOCK_SKEW_MS;
    if (message.status === QUEUED_STATUS && !beforeLoadedHistory) {
      listed.push(message);
    } else if (DELIVERED_STATUSES.has(message.status) && !beforeLoadedHistory && !(now - createdAt > DELIVERED_VISIBLE_MS)) {
      listed.push(message);
    }
  }
  return listed;
}

type SharedSessionOutboxProps = {
  /** The viewer's recent messages, from the live poll plus any it has not caught up with yet. */
  messages: SharedSessionOutgoingMessage[];
  chatMessages: ChatMessage[];
  ownerName: string;
  viewerName: string | null;
  /** Whether older history than the loaded rows exists, which bounds what "not in the transcript" can mean. */
  hasEarlierHistory: boolean;
};

/**
 * The viewer's messages the transcript does not show yet, drawn as faded
 * bubbles under it: waiting for the owner to confirm, queued, just delivered,
 * or refused with the reason. Rendered by the shared-session page.
 */
export default function SharedSessionOutbox({
  messages,
  chatMessages,
  ownerName,
  viewerName,
  hasEarlierHistory,
}: SharedSessionOutboxProps) {
  const { t } = useTranslation('chat');
  // Failures the viewer closed; they would otherwise stay listed for a day.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  // The time visibility is judged against, advanced on a timer so a delivered message drops out even when nothing else changes.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const listed = useMemo(
    () => selectOutboxMessages({
      messages,
      chatMessages,
      viewerName,
      hasEarlierHistory,
      dismissedIds,
      now,
    }),
    [chatMessages, dismissedIds, hasEarlierHistory, messages, now, viewerName],
  );

  if (listed.length === 0) {
    return null;
  }

  const describeStatus = (message: SharedSessionOutgoingMessage): string => {
    switch (message.status) {
      case 'awaiting_confirmation':
        return t('sharedSession.outbox.awaitingConfirmation', { owner: ownerName, defaultValue: 'Waiting for {{owner}} to confirm' });
      case 'pending':
      case 'queued':
        return t('sharedSession.outbox.queued', { defaultValue: 'Queued' });
      case 'declined':
        return t('sharedSession.outbox.declined', { owner: ownerName, defaultValue: '{{owner}} declined this message' });
      case 'expired':
        return t('sharedSession.outbox.expired', { defaultValue: 'Expired before it was delivered' });
      case 'failed': {
        const reason = message.error?.message?.trim();
        const label = t('sharedSession.outbox.failed', { defaultValue: 'Not delivered' });
        return reason ? `${label}: ${reason}` : label;
      }
      default:
        return t('sharedSession.outbox.delivered', { defaultValue: 'Delivered' });
    }
  };

  return (
    <div className="space-y-3" data-testid="shared-session-outbox">
      {listed.map((message) => {
        const failed = FAILED_STATUSES.has(message.status);
        const delivered = DELIVERED_STATUSES.has(message.status);
        const StatusIcon = failed ? AlertCircleIcon : delivered ? CheckIcon : ClockIcon;
        return (
          <div key={message.id} className="flex justify-end px-3 sm:px-0" data-message-status={message.status}>
            <div className="flex max-w-full flex-col items-end gap-1 sm:max-w-[85%] md:max-w-md lg:max-w-lg xl:max-w-xl">
              <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-dashed border-border bg-muted/30 px-3 py-2 font-serif text-sm text-foreground/70 sm:px-4">
                {message.text}
              </div>
              <div className={`flex items-center gap-1 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
                <StatusIcon className="h-3 w-3 shrink-0" aria-hidden />
                <span>{describeStatus(message)}</span>
                {failed && (
                  <button
                    type="button"
                    onClick={() => setDismissedIds((previous) => new Set(previous).add(message.id))}
                    className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t('sharedSession.outbox.dismiss', { defaultValue: 'Dismiss' })}
                    title={t('sharedSession.outbox.dismiss', { defaultValue: 'Dismiss' })}
                  >
                    <XIcon className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
