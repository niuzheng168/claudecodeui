import type { ReactNode, Ref } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { ComposerMenuAnchor } from '@/shared/types';

/**
 * Used by chat's model, permission, completion, voice/rewrite and tools popovers for one bounded,
 * portalled surface. Form controls use a non-modal dialog instead of menu roles.
 */
export function ComposerMenuSurface({
  anchor,
  menuRef,
  ariaLabel,
  children,
  role = 'menu',
}: {
  anchor: ComposerMenuAnchor;
  menuRef: Ref<HTMLDivElement>;
  ariaLabel: string;
  children: ReactNode;
  role?: 'menu' | 'dialog';
}) {
  return (
    <div
      ref={menuRef}
      role={role}
      aria-modal={role === 'dialog' ? false : undefined}
      aria-label={ariaLabel}
      className="fixed z-[100] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
      style={{
        right: anchor.right,
        bottom: anchor.bottom,
        top: anchor.top,
        maxHeight: anchor.maxHeight,
        width: anchor.maxWidth,
        maxWidth: anchor.maxWidth,
      }}
    >
      {children}
    </div>
  );
}

/** Chat's model, permission, voice/rewrite and tools popovers use this section heading. */
export function ComposerMenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>
  );
}

/** Chat's model and tools popovers use this divider between related settings. */
export function ComposerMenuSeparator() {
  return <div className="my-1 h-px bg-border" aria-hidden />;
}

/**
 * Used by chat's ComposerModelMenu and ComposerPermissionMenu to render one
 * selectable row with its checked state, and by ComposerSendMenu for rows
 * that can be disabled or need the destructive (Stop / Send anyway) styling.
 */
export function ComposerMenuItem({
  label,
  description,
  icon,
  isSelected,
  onSelect,
  role = 'menuitemradio',
  trailing,
  className,
  disabled = false,
  destructive = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
  role?: 'menuitemradio' | 'menuitem' | 'button';
  trailing?: ReactNode;
  className?: string;
  /** Row cannot be selected; dimmed and marked `disabled`/`aria-disabled`. Defaults off for the model/permission/schedule menus. */
  disabled?: boolean;
  /** Destructive styling (red text) for rows like Stop or Send anyway. Defaults off for the model/permission/schedule menus. */
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemradio' ? isSelected : undefined}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        destructive ? 'text-destructive' : isSelected ? 'text-foreground' : 'text-foreground/90',
        className,
      )}
    >
      {icon && <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-5">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{description}</span>
        )}
      </span>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {trailing ?? (isSelected ? <Check className="h-3.5 w-3.5 text-foreground" /> : null)}
      </span>
    </button>
  );
}
