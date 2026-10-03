import { afterEach, expect, test, vi } from 'vitest';
import { anchorTranscriptReflow } from '@/modules/chat/utils/transcriptReflowAnchor';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture() {
  let resize = () => {};
  const disconnect = vi.fn(), observe = vi.fn(), unobserve = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe; unobserve = unobserve; disconnect = disconnect;
  });
  const container = document.createElement('div');
  container.appendChild(document.createElement('div'));
  const geometry = { height: 2000, viewport: 500, top: 1500 };
  Object.defineProperties(container, {
    scrollHeight: { get: () => geometry.height },
    clientHeight: { get: () => geometry.viewport },
    scrollTop: { get: () => geometry.top, set: value => { geometry.top = Math.max(0, Math.min(value, geometry.height - geometry.viewport)); } },
  });
  let following = true;
  const close = anchorTranscriptReflow(container, () => following);
  return { container, geometry, resize: () => resize(), close, disconnect, observe,
    readOlder: () => { following = false; } };
}

test('an image arriving long after initial hydration keeps the saved latest viewport at the tail', () => {
  const f = fixture();
  f.geometry.height += 641;
  f.resize();
  expect(f.geometry.top).toBe(2141);
  f.geometry.viewport = 300;
  f.resize();
  expect(f.geometry.top).toBe(2341);
  f.close();
  expect(f.disconnect).toHaveBeenCalledOnce();
});

test('browser layout-scroll is corrected before it can be recorded as a user scroll-up', () => {
  const f = fixture();
  let savedAsScrolledUp = false;
  f.container.addEventListener('scroll', () => {
    savedAsScrolledUp = f.geometry.height - f.geometry.viewport - f.geometry.top > 50;
  });
  f.geometry.height += 641;
  f.container.dispatchEvent(new Event('scroll'));
  expect(savedAsScrolledUp).toBe(false);
  f.close();
});

test('real scroll input and older/search ownership are never pulled to the tail by reflow', () => {
  vi.useFakeTimers();
  const f = fixture();
  f.container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  f.geometry.top -= 100;
  f.geometry.height += 641;
  f.resize();
  expect(f.geometry.top).toBe(1400);
  f.readOlder();
  vi.advanceTimersByTime(1000);
  f.resize();
  expect(f.geometry.top).toBe(1400);
  f.close();
});
