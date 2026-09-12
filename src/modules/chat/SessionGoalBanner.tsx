import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw, Target } from 'lucide-react';

import type { CodexGoalReadError, CodexSessionGoal } from '@/shared/types';

type SessionGoalBannerProps = {
  goal: CodexSessionGoal | null;
  loading: boolean;
  error: CodexGoalReadError | null;
  onRefresh: () => void;
};

/** ChatInterface keeps the native goal visible outside the scrolling transcript. */
export function SessionGoalBanner({ goal, loading, error, onRefresh }: SessionGoalBannerProps) {
  const { t, i18n } = useTranslation('chat');
  // Long objectives stay compact until the user chooses to inspect them.
  const [expanded, setExpanded] = useState(false);
  const objectiveId = useId();
  if (!goal && !error) return null;

  const formatNumber = (value: number) => value.toLocaleString(i18n.language);
  const seconds = Math.floor(goal?.timeUsedSeconds ?? 0);
  const elapsed = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const active = goal?.status === 'active' && !error;
  const status = goal ? t(`goal.status.${goal.status}`) : null;

  return (
    <section aria-label={t('goal.title')} className="shrink-0 border-b border-border/50 bg-card/60">
      <div className="mx-auto flex w-full max-w-[54.25rem] items-start gap-2 px-4 py-2">
        <Target className={`mt-1 h-4 w-4 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-semibold">{t('goal.title')}</span>
            {status && (
              <span role="status" className={`inline-flex items-center gap-1.5 ${active ? 'text-primary' : 'text-muted-foreground'}`}>
                {active && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" aria-hidden />}
                {error ? t('goal.lastStatus', { status }) : status}
              </span>
            )}
          </div>
          {goal && (
            <>
              <p
                id={objectiveId}
                className={`whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere] ${expanded ? 'max-h-32 overflow-y-auto' : 'line-clamp-2'}`}
              >
                {goal.objective}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                <span>{t('goal.tokens', {
                  used: formatNumber(goal.tokensUsed),
                  budget: goal.tokenBudget === null ? t('goal.unlimited') : formatNumber(goal.tokenBudget),
                })}</span>
                <span>{t('goal.elapsed', { time: elapsed })}</span>
              </div>
            </>
          )}
          {error && <p role="status" className="mt-1 text-xs text-muted-foreground">
            {t(error === 'unsupported' ? 'goal.unsupported' : goal ? 'goal.stale' : 'goal.unavailable')}
          </p>}
        </div>
        <div className="flex shrink-0 items-center">
          {goal && (
            <button
              type="button"
              aria-label={t(expanded ? 'goal.collapse' : 'goal.expand')}
              aria-expanded={expanded}
              aria-controls={objectiveId}
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
            </button>
          )}
          <button
            type="button"
            aria-label={t('goal.refresh')}
            title={t('goal.refresh')}
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
          </button>
        </div>
      </div>
    </section>
  );
}
