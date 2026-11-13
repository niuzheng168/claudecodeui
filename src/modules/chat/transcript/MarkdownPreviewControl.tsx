import { lazy, Suspense, useContext, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MarkdownPreviewContext } from '@/modules/chat/context/MarkdownPreviewContext';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui';

// Keep the expanded renderer off the transcript's initial render path.
const MarkdownPreviewModal = lazy(() => import('@/modules/chat/modals/MarkdownPreviewModal'));

type MarkdownPreviewControlProps = {
  content: string;
  /** A known Markdown/Mermaid code block needs no message-level detection. */
  language?: string;
};

// An affordance heuristic, not a second Markdown parser. Avoid parsing every
// streamed reply twice, while covering block, inline, GFM and math syntax.
const MARKDOWN_PATTERNS = [
  /(?:^|\n)[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+|`{3,}|~{3,})/,
  /(?:^|\n)[ \t]{0,3}(?:=+|-+|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*(?:\r?\n|$)/,
  /(?:^|\n)(?: {4}|\t)\S/,
  /(?:^|\n)[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*\|[ \t]*:?-{1,}/,
  /!?\[[^\]\n]+\](?:\([^\n)]*\)|\[[^\]\n]*\])/,
  /(?:^|\n)[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S/,
  /(\*\*|__|~~)[^\n]+?\1|`[^`\n]+`/,
  /\*[^\s*\n](?:[^*\n]*[^\s*\n])?\*|(?:^|[\s(])_[^_\n]+_(?=$|[\s.,!?，。！？)])/,
  /\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/,
];

/** Used by chat's message footers and code blocks to open an expanded Markdown preview. */
export function MarkdownPreviewControl({ content, language }: MarkdownPreviewControlProps) {
  const { t } = useTranslation('chat');
  const isPreview = useContext(MarkdownPreviewContext);
  const { isExporting } = useContext(TranscriptRenderContext);
  // The dialog stays mounted when closed so its focus restoration can run.
  const [isOpen, setIsOpen] = useState(false);
  const canPreview = useMemo(
    () => Boolean(content.trim()) && (Boolean(language) || MARKDOWN_PATTERNS.some((pattern) => pattern.test(content))),
    [content, language],
  );

  if (isPreview || isExporting || !canPreview) {
    return null;
  }

  const title = t('markdownPreview.title', { defaultValue: 'Markdown preview' });

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger
        className="not-prose inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 font-sans text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{t('markdownPreview.preview', { defaultValue: 'Preview' })}</span>
      </DialogTrigger>
      <DialogContent
        aria-label={title}
        className="flex h-[92dvh] w-[calc(100%-1rem)] max-w-6xl flex-col overflow-hidden bg-background font-sans text-foreground sm:w-[calc(100%-3rem)]"
      >
        <Suspense fallback={<div role="status" className="p-6">{t('markdownPreview.loading', { defaultValue: 'Loading preview…' })}</div>}>
          <MarkdownPreviewModal content={content} language={language} onClose={() => setIsOpen(false)} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
