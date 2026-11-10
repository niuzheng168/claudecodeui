import { useTranslation } from 'react-i18next';

import type { LLMProvider, SharedSessionMode } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';

type SharedSessionHeaderProps = {
  title: string | null;
  ownerName: string;
  provider: LLMProvider;
  mode: SharedSessionMode;
  expiresAt: string | null;
};

/**
 * The shared-session page's title bar: the session's title, whose session it
 * is, and what happens to a message sent from here (the owner confirms it, or
 * it goes straight to the agent).
 */
export default function SharedSessionHeader({ title, ownerName, provider, mode, expiresAt }: SharedSessionHeaderProps) {
  const { t, i18n } = useTranslation('chat');
  const expiresTime = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const details = [
    t('sharedSession.header.sharedBy', { owner: ownerName, defaultValue: '{{owner}} shared this with you' }),
    mode === 'auto'
      ? t('sharedSession.header.modeAuto', { defaultValue: 'Your messages go straight to the agent' })
      : t('sharedSession.header.modeConfirm', { owner: ownerName, defaultValue: 'Your messages wait for {{owner}} to confirm' }),
    ...(Number.isFinite(expiresTime)
      ? [t('sharedSession.header.expires', {
        date: new Date(expiresTime).toLocaleDateString(i18n.language),
        defaultValue: 'Until {{date}}',
      })]
      : []),
  ];

  return (
    <header className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-background px-4 py-2.5">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1">
        <LLMProviderLogo provider={provider} className="h-full w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold text-foreground" title={title ?? undefined}>
          {title || t('sharedSession.header.untitled', { defaultValue: 'Shared session' })}
        </h1>
        <p className="truncate text-xs text-muted-foreground">{details.join(' · ')}</p>
      </div>
    </header>
  );
}
