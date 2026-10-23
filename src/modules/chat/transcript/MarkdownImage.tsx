import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';

import { TranscriptProjectContext } from '@/modules/chat/context/TranscriptProjectContext';
import { useProjectImageSrc } from '@/modules/chat/hooks/useProjectImageSrc';
import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';

type MarkdownImageProps = {
  src?: string;
  alt?: string;
  title?: string;
};

/**
 * Only HTTP(S) images go directly to the browser. Everything file-like is read
 * by the existing project API, which enforces project/worktree boundaries and
 * permits only verified session-owned Codex visualization images outside them.
 * Do not turn arbitrary schemes into browser sources or credentialed requests.
 */
function resolveImageSource(src?: string): { kind: 'remote' | 'file'; value: string } | null {
  const value = src?.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith('//')) {
    return { kind: 'remote', value };
  }

  let filePath = value;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      filePath = url.pathname;
      // file:///C:/... must remain a drive-absolute path on Windows nodes.
      if (/^\/[a-z]:\//i.test(filePath)) filePath = filePath.slice(1);
    } catch {
      return null;
    }
  } else if (/^sandbox:\/(?!\/)/i.test(value)) {
    filePath = value.slice('sandbox:'.length);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(value)) {
    return null;
  }

  try {
    // Decode once, after removing URL-only suffixes, so encoded #/? in actual
    // filenames survive and Markdown's percent-encoded spaces/Unicode work.
    filePath = decodeURIComponent(filePath.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (!filePath || /[\u0000-\u001f\u007f]/.test(filePath)) return null;
  return { kind: 'file', value: filePath };
}

/**
 * Used by Markdown for both historical/streaming replies and nested tool Markdown.
 * Shows images the model references (screenshots it took, files it generated)
 * inline, with the same click-to-expand lightbox as user attachments.
 */
export function MarkdownImage({ src, alt = '', title }: MarkdownImageProps) {
  const { t } = useTranslation('chat');
  const projectId = useContext(TranscriptProjectContext);
  const source = resolveImageSource(src);
  const image = useProjectImageSrc(projectId, source?.kind === 'file' ? source.value : null);
  // Keyed by the displayed URL so a project/path change or retry closes the
  // lightbox instead of reopening it on the next image.
  const [expandedSrc, setExpandedSrc] = useState<string | null>(null);

  // Public web images never receive the node's Authorization header.
  const displaySrc = source?.kind === 'remote' ? source.value : image.src;

  if (!source || image.failed) {
    return (
      <span className="my-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-3 text-sm" role="status">
        <ImageOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {alt && <span>{alt}</span>}
        <span>{t('images.unavailable', { defaultValue: 'Image unavailable. Check the node connection and file path.' })}</span>
        {source && projectId && (
          <button type="button" onClick={image.retry} className="text-primary underline">
            {t('images.retry', { defaultValue: 'Retry image' })}
          </button>
        )}
      </span>
    );
  }

  if (!displaySrc) {
    return (
      <span className="my-2 inline-block rounded-lg bg-muted p-3 text-sm text-muted-foreground" role="status">
        {t('images.loading', { defaultValue: 'Loading image…' })}{alt && ` ${alt}`}
      </span>
    );
  }

  const label = alt || title || source.value;

  return (
    <>
      <button
        type="button"
        onClick={() => setExpandedSrc(displaySrc)}
        aria-label={t('misc.expandImage', { name: label, defaultValue: 'Expand {{name}}' })}
        className="my-2 block max-w-full overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img
          src={displaySrc}
          alt={alt}
          title={title}
          loading="lazy"
          className="block max-h-96 max-w-full cursor-zoom-in rounded-lg object-contain"
          onError={source.kind === 'file' ? image.markFailed : undefined}
        />
      </button>
      {expandedSrc === displaySrc && (
        <ImageLightbox src={displaySrc} alt={label} onClose={() => setExpandedSrc(null)} />
      )}
    </>
  );
}
