import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { AudioPreviewSource } from '@/shared/types';

/** ChatAudioPreview uses authenticated blobs for node files and keeps public audio outside the credentialed API. */
export function useAudioPreviewSrc(projectId: string | null, source: AudioPreviewSource) {
  const { kind, value, mimeType } = source;
  const scopedProjectId = kind === 'file' ? projectId : null;
  /** Retrying invalidates a failed request without changing the message or attachment. */
  const [attempt, setAttempt] = useState(0);
  /** Async results belong to a single source so switching projects cannot display or play stale audio. */
  const [result, setResult] = useState<{ key: string; src: string | null; failed: boolean } | null>(null);
  const key = JSON.stringify([scopedProjectId, kind, value, mimeType, attempt]);

  useEffect(() => {
    if (kind === 'remote' || (kind === 'file' && !scopedProjectId)) return;

    const controller = new AbortController();
    let objectUrl: string | null = null;

    const load = async () => {
      try {
        const options = { signal: controller.signal, cache: 'no-store' as const };
        const response = kind === 'file' && scopedProjectId
          ? await api.readFileBlob(scopedProjectId, value, options)
          : await api.assets.file(value, options);
        if (controller.signal.aborted) return;

        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
        const isGenericType = !contentType || contentType === 'application/octet-stream';
        const isContainerType = contentType === 'application/ogg'
          || (mimeType === 'audio/mp4' && contentType === 'video/mp4')
          || (mimeType === 'audio/webm' && contentType === 'video/webm');
        if (!response.ok || (!contentType.startsWith('audio/') && !isGenericType && !isContainerType)) {
          throw new Error('Audio unavailable');
        }

        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!blob.size) throw new Error('Empty audio');
        const playbackType = isGenericType || isContainerType ? mimeType : contentType;
        const typedBlob = blob.type === playbackType ? blob : new Blob([blob], { type: playbackType });
        objectUrl = URL.createObjectURL(typedBlob);
        setResult({ key, src: objectUrl, failed: false });
      } catch {
        if (!controller.signal.aborted) setResult({ key, src: null, failed: true });
      }
    };
    void load();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, kind, value, mimeType, scopedProjectId]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);
  const markFailed = useCallback(() => setResult({ key, src: null, failed: true }), [key]);
  const current = result?.key === key ? result : null;
  const failed = Boolean((kind === 'file' && !scopedProjectId) || current?.failed);

  return {
    src: failed ? null : kind === 'remote' ? value : current?.src ?? null,
    failed,
    retry,
    markFailed,
  };
}
