import { useContext } from 'react';
import { useTranslation } from 'react-i18next';

import { TranscriptProjectContext } from '@/modules/chat/context/TranscriptProjectContext';
import { useProjectImageSrc } from '@/modules/chat/hooks/useProjectImageSrc';

type MarkdownImageProps = {
  src?: string;
  alt?: string;
  title?: string;
};

/**
 * Only HTTP(S) images go directly to the browser. Everything file-like is read
 * by the existing project API, which enforces its project-root boundary.
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

/** Used by Markdown for both historical/streaming replies and nested tool Markdown. */
export function MarkdownImage({ src, alt = '', title }: MarkdownImageProps) {
  const { t } = useTranslation('chat');
  const projectId = useContext(TranscriptProjectContext);
  const source = resolveImageSource(src);
  const image = useProjectImageSrc(projectId, source?.kind === 'file' ? source.value : null);

  // Public web images never receive the node's Authorization header.
  if (source?.kind === 'remote') {
    return <img src={source.value} alt={alt} title={title} loading="lazy" />;
  }

  if (!source || image.failed) {
    return (
      <span className="my-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-3 text-sm" role="status">
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

  if (!image.src) {
    return (
      <span className="my-2 inline-block rounded-lg bg-muted p-3 text-sm text-muted-foreground" role="status">
        {t('images.loading', { defaultValue: 'Loading image…' })}{alt && ` ${alt}`}
      </span>
    );
  }

  return (
    <img
      src={image.src}
      alt={alt}
      title={title}
      loading="lazy"
      className="max-w-full rounded-lg"
      onError={image.markFailed}
    />
  );
}
