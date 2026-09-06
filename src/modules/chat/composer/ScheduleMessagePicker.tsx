import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type ScheduleMessagePickerProps = {
  disabled: boolean;
  onSchedule: (scheduledFor: Date) => void;
};

/** Offsets people actually mean when they say "later". */
const QUICK_OFFSETS_MINUTES = [15, 60, 8 * 60, 24 * 60];

/**
 * Turns the picker's `datetime-local` value into an absolute instant.
 *
 * That input carries no zone, and `new Date(value)` reads it in the browser's
 * — which is what the user meant, since they picked it off their own clock.
 * Converting here means the server stores one unambiguous instant, so the
 * schedule does not move if they are on another device when it fires.
 */
function readLocalDateTime(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toLocalInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Used inside ComposerToolsMenu's second view. Keeping one popup (not nested
 * portalled menus) prevents outside-click dismissal from swallowing date input.
 */
export function ScheduleMessagePicker({ disabled, onSchedule }: ScheduleMessagePickerProps) {
  const { t } = useTranslation('chat');
  const inputId = useId();
  // Snapshot the opening time so labels do not jump while a custom time is being edited.
  const [openedAt] = useState(() => Date.now());
  // Seeded an hour out, because a picker that opens on "now" is never what
  // scheduling means.
  const [customValue, setCustomValue] = useState(() => toLocalInputValue(new Date(openedAt + 3_600_000)));
  const customDate = readLocalDateTime(customValue);
  const validCustomDate = Boolean(customDate && customDate.getTime() > openedAt);

  const commit = (scheduledFor: Date) => {
    if (!disabled && scheduledFor.getTime() > Date.now()) onSchedule(scheduledFor);
  };

  return (
    <>
          <ComposerMenuHeading>{t('schedule.heading')}</ComposerMenuHeading>
          {QUICK_OFFSETS_MINUTES.map((minutes) => (
            <ComposerMenuItem
              key={minutes}
              label={t(`schedule.in.${minutes}`)}
              description={new Date(openedAt + minutes * 60_000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              isSelected={false}
              role="button"
              disabled={disabled}
              onSelect={() => commit(new Date(Date.now() + minutes * 60_000))}
            />
          ))}

          <ComposerMenuSeparator />
          <div className="px-2.5 pb-1.5">
            <label className="block text-[11px] font-medium text-muted-foreground" htmlFor={inputId}>
              {t('schedule.customLabel')}
            </label>
            <input
              id={inputId}
              type="datetime-local"
              disabled={disabled}
              aria-invalid={!validCustomDate}
              value={customValue}
              onChange={(event) => setCustomValue(event.target.value)}
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground"
            />
            <button
              type="button"
              disabled={disabled || !validCustomDate}
              onClick={() => {
                const parsed = readLocalDateTime(customValue);
                if (parsed) commit(parsed);
              }}
              className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('schedule.confirm')}
            </button>
            {!validCustomDate && <p className="mt-1 text-xs text-muted-foreground">{t('schedule.futureTime')}</p>}
          </div>
    </>
  );
}
