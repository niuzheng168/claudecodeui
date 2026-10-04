import { useContext } from 'react';
import type { ReactNode } from 'react';
import { Music2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { TranscriptProjectContext } from '@/modules/chat/context/TranscriptProjectContext';
import { useAudioPreviewSrc } from '@/modules/chat/hooks/useAudioPreviewSrc';
import type { AudioPreviewSource } from '@/shared/types';

type ChatAudioPreviewProps = {
  source: AudioPreviewSource;
  name: string;
  children?: ReactNode;
};

/** Markdown and ChatMessageFiles render audio in-place while retaining file links and attachment downloads. */
export function ChatAudioPreview({ source, name, children }: ChatAudioPreviewProps) {
  const { t } = useTranslation('chat');
  const projectId = useContext(TranscriptProjectContext);
  const audio = useAudioPreviewSrc(projectId, source);

  return (
    <span className="not-prose my-2 inline-flex w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3 align-middle">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <Music2Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 break-words">{children ?? name}</span>
      </span>
      {audio.src ? (
        <audio
          src={audio.src}
          controls
          preload="none"
          aria-label={t('audio.player', { name, defaultValue: `Audio player: ${name}` })}
          className="w-full min-w-0"
          onError={audio.markFailed}
        />
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="status">
          {audio.failed
            ? t('audio.unavailable', { defaultValue: 'Audio unavailable. Check the node connection, file path, or audio format.' })
            : t('audio.loading', { defaultValue: 'Loading audio…' })}
          {audio.failed && (source.kind !== 'file' || projectId) && (
            <button type="button" onClick={audio.retry} className="text-primary underline">
              {t('audio.retry', { defaultValue: 'Retry audio' })}
            </button>
          )}
        </span>
      )}
    </span>
  );
}
