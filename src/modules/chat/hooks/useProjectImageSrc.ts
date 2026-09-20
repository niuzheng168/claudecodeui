import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

/** Used by chat's MarkdownImage to read project images through node-scoped authentication. */
export function useProjectImageSrc(projectId: string | null, imagePath: string | null) {
  // A new attempt invalidates a failed request without changing the saved Markdown.
  const [attempt, setAttempt] = useState(0);
  // Bind async results to their request so a project/path change never shows the old file.
  const [result, setResult] = useState<{ key: string; src: string | null; failed: boolean } | null>(null);
  const key = JSON.stringify([projectId, imagePath, attempt]);

  useEffect(() => {
    if (!projectId || !imagePath) return;

    const controller = new AbortController();
    let objectUrl: string | null = null;

    const load = async () => {
      try {
        const response = await api.readFileBlob(projectId, imagePath, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (controller.signal.aborted) return;
        // An expired login or an unavailable tunnel may return HTML, not an image.
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) {
          throw new Error('Project image unavailable');
        }
        const blob = await response.blob();
        // Aborting fetch does not necessarily cancel an already-started blob read.
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
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
  }, [key, projectId, imagePath]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const markFailed = useCallback(() => setResult({ key, src: null, failed: true }), [key]);
  const current = result?.key === key ? result : null;

  return {
    src: current?.src ?? null,
    failed: Boolean(imagePath && (!projectId || current?.failed)),
    retry,
    markFailed,
  };
}
