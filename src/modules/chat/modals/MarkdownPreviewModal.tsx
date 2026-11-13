import { useState } from 'react';
import { Code, Eye, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MarkdownPreviewContext } from '@/modules/chat/context/MarkdownPreviewContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import MessageCopyControl from '@/modules/chat/transcript/MessageCopyControl';
import { MermaidDiagram } from '@/modules/code-editor';

type MarkdownPreviewModalProps = {
  content: string;
  language?: string;
  onClose: () => void;
};

/** Loaded by chat's preview control only when its expanded document dialog opens. */
export default function MarkdownPreviewModal({ content, language, onClose }: MarkdownPreviewModalProps) {
  const { t } = useTranslation('chat');
  // Keep the original text available even if a diagram is incomplete or invalid.
  const [showSource, setShowSource] = useState(false);
  // Magnify the document (including SVG labels) without shrinking it back to fit.
  const [zoom, setZoom] = useState(100);
  const previewLabel = t('markdownPreview.preview', { defaultValue: 'Preview' });
  const sourceLabel = t('markdownPreview.source', { defaultValue: 'Source' });

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3 sm:px-5">
        <h2 className="text-sm font-semibold">
          {t('markdownPreview.title', { defaultValue: 'Markdown preview' })}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border p-0.5">
            <button
              type="button"
              autoFocus
              aria-pressed={!showSource}
              onClick={() => setShowSource(false)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-primary ${!showSource ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              {previewLabel}
            </button>
            <button
              type="button"
              aria-pressed={showSource}
              onClick={() => setShowSource(true)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-primary ${showSource ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Code className="h-3.5 w-3.5" aria-hidden="true" />
              {sourceLabel}
            </button>
          </div>
          {!showSource && (
            <select
              aria-label={t('markdownPreview.zoom', { defaultValue: 'Preview zoom' })}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="rounded-md border border-border bg-background px-1 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-primary"
            >
              {[75, 100, 125, 150, 200, 300].map((value) => (
                <option key={value} value={value}>{value}%</option>
              ))}
            </select>
          )}
          <MessageCopyControl content={content} messageType="assistant" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('markdownPreview.close', { defaultValue: 'Close preview' })}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-4 sm:p-8">
        {showSource ? (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">{content}</pre>
        ) : (
          <MarkdownPreviewContext.Provider value>
            {/* Percentage width offsets zoom's automatic reflow, so wide diagrams
                grow into the scroll area instead of being squeezed back to fit. */}
            <div style={{ zoom: zoom / 100, width: `${zoom}%` }}>
              {language === 'mermaid' ? (
                <MermaidDiagram code={content} />
              ) : (
                <Markdown className="prose max-w-none break-words dark:prose-invert">
                  {content}
                </Markdown>
              )}
            </div>
          </MarkdownPreviewContext.Provider>
        )}
      </div>
    </>
  );
}
