import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

type Props = {
  prefix: string;
  suffix: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onVisibilityChange: (visible: boolean) => void;
};

/** ChatComposer displays ghost text only when the entire proposal fits; touch/RTL/overflow use the readable bar. */
export function ComposerCompletionOverlay({ prefix, suffix, textareaRef, onVisibilityChange }: Props) {
  // Measured mirrors never own draft text, input focus, or pointer events.
  const mirrorRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const suffixRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    const content = contentRef.current;
    const proposal = suffixRef.current;
    if (!textarea || !mirror || !content || !proposal) return;
    const measure = () => {
      const style = getComputedStyle(textarea);
      Object.assign(mirror.style, {
        left: `${textarea.offsetLeft}px`, top: `${textarea.offsetTop}px`,
        width: `${textarea.clientWidth}px`, height: `${textarea.clientHeight}px`,
        font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
        textAlign: style.textAlign, textIndent: style.textIndent,
        direction: style.direction, boxSizing: 'border-box',
      });
      Object.assign(content.style, {
        padding: style.padding, width: `${textarea.clientWidth}px`, boxSizing: 'border-box',
        transform: `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`,
      });
      const box = textarea.getBoundingClientRect();
      const rectangles = [...proposal.getClientRects()];
      const visible = window.innerWidth >= 640 && !window.matchMedia('(pointer: coarse)').matches &&
        style.direction !== 'rtl' && !/[\u0590-\u08ff]/u.test(prefix + suffix) && rectangles.length > 0 &&
        rectangles.every((rect) => rect.top >= box.top && rect.bottom <= box.bottom + 0.5 &&
          rect.left >= box.left && rect.right <= box.left + textarea.clientWidth + 0.5);
      mirror.style.visibility = visible ? 'visible' : 'hidden';
      onVisibilityChange(visible);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(textarea);
    textarea.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      textarea.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [prefix, suffix, textareaRef, onVisibilityChange]);
  return (
    <div ref={mirrorRef} aria-hidden="true" data-testid="completion-ghost"
      className="pointer-events-none absolute overflow-hidden" style={{ visibility: 'hidden' }}>
      <div ref={contentRef} className="whitespace-pre-wrap break-words text-transparent">
        {prefix}<span ref={suffixRef} className="text-muted-foreground">{suffix}</span>
      </div>
    </div>
  );
}
