import { memo } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  /** The selected model's window from its catalog, known before the first turn. */
  contextWindow?: number;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  // A long session's total re-reads its cached context on every request.
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, '')}B`;
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * ComposerToolbar's quiet secondary row shows usage and keeps the detailed
 * breakdown reachable without a large pill competing with the Send button.
 *
 * Two numbers: every token the session's requests consumed, and what the
 * context window holds now against its size.
 */
function TokenUsageSummary({ usage, contextWindow, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation('chat');
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = Math.max(0, readUsageNumber(usage?.used) || inputTokens + outputTokens);
  // A provider's own total only counts once it has reported usage, and not
  // when the usage already exceeds it: then it is a CONTEXT_WINDOW guess for
  // a model that holds more.
  const reportedTotal = usedTokens > 0 ? readUsageNumber(usage?.total) : 0;
  const totalTokens = readUsageNumber(contextWindow)
    || (reportedTotal >= usedTokens ? reportedTotal : 0);
  // No usage yet means nothing spent yet. Usage without a session total comes
  // from a provider that does not report one, which shows the context alone.
  const sessionTokens = !usage
    ? 0
    : usage.sessionTokens == null ? null : Math.max(0, readUsageNumber(usage.sessionTokens));

  const contextCounts = {
    tokens: formatTokenCount(usedTokens), total: formatTokenCount(totalTokens),
  };
  const contextExactCounts = {
    tokens: usedTokens.toLocaleString(), total: totalTokens.toLocaleString(),
  };
  let label: string;
  let title: string;
  if (sessionTokens === null) {
    label = totalTokens > 0
      ? t('composer.tokenCountOfTotal', contextCounts)
      : t('composer.tokenCount', contextCounts);
    title = totalTokens > 0
      ? t('composer.tokensUsedOfTotal', contextExactCounts)
      : t('composer.tokensUsed', contextExactCounts);
  } else {
    label = `${t('composer.sessionTokenCount', { tokens: formatTokenCount(sessionTokens) })} · ${totalTokens > 0
      ? t('composer.contextTokenCountOfTotal', contextCounts)
      : t('composer.contextTokenCount', contextCounts)}`;
    title = `${t('composer.sessionTokensUsed', { tokens: sessionTokens.toLocaleString() })}\n${totalTokens > 0
      ? t('composer.contextTokensUsedOfTotal', contextExactCounts)
      : t('composer.contextTokensUsed', contextExactCounts)}`;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={title}
      aria-label={t('composer.tokenUsage')}
    >
      <ActivityIcon className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
