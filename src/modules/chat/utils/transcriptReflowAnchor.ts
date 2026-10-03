/**
 * Used by useChatSessionState to keep an intentionally pinned tail in view
 * when images, markdown or the composer resize after hydration. Reading older
 * messages/search retains ownership; actual wheel/touch/key/scrollbar input
 * always wins over automatic anchoring.
 */
export function anchorTranscriptReflow(container: HTMLElement, shouldFollow: () => boolean): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  let height = container.scrollHeight;
  let viewport = container.clientHeight;
  let manualUntil = 0;
  let intentTimer: ReturnType<typeof setTimeout> | undefined;
  const rememberLayout = () => {
    height = container.scrollHeight;
    viewport = container.clientHeight;
  };
  const pin = () => {
    if (Date.now() >= manualUntil && shouldFollow()) {
      container.scrollTop = container.scrollHeight;
    }
    rememberLayout();
  };
  const intent = () => {
    manualUntil = Date.now() + 250;
    clearTimeout(intentTimer);
    // A downward gesture already at the bottom emits no scroll. Resume
    // following after the gesture; genuine upward scrolling changed the ref.
    intentTimer = setTimeout(pin, 250);
  };
  const pointer = (event: PointerEvent) => {
    if (event.target === container) intent(); // scrollbar, not a message action
  };
  const keyboard = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) intent();
  };
  const beforeScroll = () => {
    // Native scroll anchoring can emit a scroll before ResizeObserver runs.
    // Correct that layout-only move before the hook mistakes it for user
    // intent and persists "scrolled up" over the latest saved checkpoint.
    if (height !== container.scrollHeight || viewport !== container.clientHeight) pin();
    else rememberLayout();
  };
  const sizes = new ResizeObserver(pin);
  const observed = new Set<Element>();
  const watchRows = () => {
    const rows = new Set<Element>([container, ...container.children]);
    for (const row of observed) if (!rows.has(row)) { sizes.unobserve(row); observed.delete(row); }
    for (const row of rows) if (!observed.has(row)) { sizes.observe(row); observed.add(row); }
  };
  watchRows();
  const children = new MutationObserver(watchRows);
  children.observe(container, { childList: true });
  container.addEventListener('scroll', beforeScroll, true);
  container.addEventListener('wheel', intent, { passive: true, capture: true });
  container.addEventListener('touchmove', intent, { passive: true, capture: true });
  container.addEventListener('pointerdown', pointer, true);
  container.addEventListener('keydown', keyboard, true);
  return () => {
    sizes.disconnect();
    children.disconnect();
    clearTimeout(intentTimer);
    container.removeEventListener('scroll', beforeScroll, true);
    container.removeEventListener('wheel', intent, true);
    container.removeEventListener('touchmove', intent, true);
    container.removeEventListener('pointerdown', pointer, true);
    container.removeEventListener('keydown', keyboard, true);
  };
}
