import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComposerMenuAnchor } from '@/shared/types';


const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

/** Chat's model, permission, voice/rewrite and tools popovers share positioning and keyboard dismissal. */
export function useComposerMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
  align: 'start' | 'end' = 'end',
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Popup placement follows the actual iframe viewport rather than the outer portal's width.
  const [anchor, setAnchor] = useState<ComposerMenuAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const width = Math.max(0, Math.min(preferredWidth, window.innerWidth - 2 * VIEWPORT_MARGIN));
    const left = Math.max(VIEWPORT_MARGIN, Math.min(
      align === 'start' ? rect.left : rect.right - width,
      window.innerWidth - VIEWPORT_MARGIN - width,
    ));
    const triggerTop = Math.max(VIEWPORT_MARGIN, Math.min(rect.top, window.innerHeight - VIEWPORT_MARGIN));
    const triggerBottom = Math.max(VIEWPORT_MARGIN, Math.min(rect.bottom, window.innerHeight - VIEWPORT_MARGIN));
    const above = Math.max(0, triggerTop - MENU_GAP - VIEWPORT_MARGIN);
    const below = Math.max(0, window.innerHeight - triggerBottom - MENU_GAP - VIEWPORT_MARGIN);
    const openAbove = above >= Math.min(240, below);
    setAnchor({
      right: Math.max(VIEWPORT_MARGIN, window.innerWidth - left - width),
      ...(openAbove
        ? { bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - triggerTop + MENU_GAP) }
        : { top: Math.max(VIEWPORT_MARGIN, triggerBottom + MENU_GAP) }),
      maxHeight: openAbove ? above : below,
      maxWidth: width,
    });
  }, [align, preferredWidth]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleOutside = (event: Event) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        triggerRef.current?.focus();
        return;
      }
      const menu = menuRef.current;
      if (menu?.getAttribute('role') !== 'menu' ||
          (!menu.contains(event.target as Node) && event.target !== triggerRef.current)) return;
      if (event.key === 'Tab') {
        onClose();
        triggerRef.current?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(
        'button[role^="menuitem"]:not(:disabled)',
      ));
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      items[next].focus();
    };

    // Entering a popup never starts recording or submits the surrounding form.
    const focusTimer = window.setTimeout(() => {
      const menu = menuRef.current;
      const target = menu?.querySelector<HTMLElement>('button[aria-checked="true"]:not(:disabled)')
        ?? menu?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)');
      target?.focus();
    }, 0);
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('focusin', handleOutside);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateAnchor();

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('focusin', handleOutside);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, onClose, updateAnchor]);

  return { triggerRef, menuRef, anchor, updateAnchor };
}
