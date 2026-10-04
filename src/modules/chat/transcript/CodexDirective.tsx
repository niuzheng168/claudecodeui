import { useContext } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'react-markdown';

import { TranscriptFollowupContext } from '@/modules/chat/context/TranscriptFollowupContext';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { usePaletteOps } from '@/modules/command-palette';

/** Used by chat's Markdown renderer for parsed Codex suggestions and file citations. */
export function CodexDirective({ node, children, ...props }: ComponentPropsWithoutRef<'span'> & ExtraProps) {
  const onFollowup = useContext(TranscriptFollowupContext);
  const isExporting = useIsExportingTranscript();
  const { openFileInEditor } = usePaletteOps();
  const prompt = node?.properties['data-codex-followup'];
  const path = node?.properties['data-codex-file-path'];

  if (typeof prompt === 'string') {
    if (isExporting || !onFollowup) return <span title={prompt}>{children}</span>;
    return (
      <button
        type="button"
        title={prompt}
        className="inline-flex max-w-full whitespace-normal break-words rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onFollowup(prompt)}
      >
        {children}
      </button>
    );
  }

  if (typeof path === 'string') {
    if (isExporting) return <span title={path}>{children}</span>;
    return (
      <a
        // Use an inert anchor even for Windows paths. The literal path is only
        // passed to the existing editor operation, never used as a URL scheme.
        href="#"
        title={path}
        className="cursor-pointer break-words text-blue-600 hover:underline dark:text-blue-400"
        onClick={(event) => {
          event.preventDefault();
          openFileInEditor(path);
        }}
      >
        {children}
      </a>
    );
  }

  // Preserve ordinary spans, including KaTeX output, without leaking hast nodes.
  return <span {...props}>{children}</span>;
}
