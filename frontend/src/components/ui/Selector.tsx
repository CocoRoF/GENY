'use client';

/**
 * Selector — the reusable dropdown switcher / styled-select primitive.
 *
 * Two looks share one popover list (icon + label + optional description +
 * active marker), fully theme-token based so light/dark stay correct:
 *   - variant="nav"   (default) — a compact violet switcher trigger.
 *     Used for navigation (env-management tab switcher, …).
 *   - variant="field" — an input-like, full-width trigger. A drop-in
 *     replacement for native <select> in forms (role / preset / template
 *     pickers, …). Supports a placeholder + grouped options.
 *
 * Outside-click / Escape close are built in.
 *
 *   <Selector variant="field" placeholder="선택…"
 *     items={[{ id, label, description?, icon?, group? }]}
 *     value={v} onChange={setV} />
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectorItem<T extends string = string> {
  id: T;
  label: string;
  description?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Optional group label — consecutive items with the same group render
   *  under one header (the "Templates" pattern). */
  group?: string;
  /** Optional right-aligned node; replaces the default active marker. */
  trailing?: ReactNode;
}

export interface SelectorProps<T extends string = string> {
  items: SelectorItem<T>[];
  value: T;
  onChange: (id: T) => void;
  variant?: 'nav' | 'field';
  size?: 'sm' | 'md';
  align?: 'start' | 'end';
  minWidthPx?: number;
  fullWidth?: boolean;
  /** Shown on the trigger when no item matches `value` (field variant). */
  placeholder?: string;
  /** Override the trigger label (defaults to the active item's label). */
  triggerLabel?: ReactNode;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export default function Selector<T extends string = string>({
  items,
  value,
  onChange,
  variant = 'nav',
  size = 'md',
  align = 'start',
  minWidthPx,
  fullWidth,
  placeholder,
  triggerLabel,
  disabled,
  className,
  ariaLabel,
}: SelectorProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Fixed-viewport coords for the portaled popover (escapes any `overflow`
  // clipping from ancestor scroll containers / modals).
  const [coords, setCoords] = useState<CSSProperties>({});

  const isField = variant === 'field';
  const expand = fullWidth ?? isField; // field defaults full-width

  const active = items.find((i) => i.id === value);
  const ActiveIcon = active?.icon;

  const recompute = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const vh = window.innerHeight;
    // Open upward when there's little room below and more room above.
    const openUp = r.bottom + 320 > vh && r.top > vh - r.bottom;
    const next: CSSProperties = { position: 'fixed', zIndex: 1000 };
    if (expand) {
      next.left = r.left;
      next.width = r.width;
    } else if (align === 'end') {
      next.right = window.innerWidth - r.right;
      next.minWidth = minWidthPx ?? 200;
    } else {
      next.left = r.left;
      next.minWidth = minWidthPx ?? 200;
    }
    if (openUp) next.bottom = vh - r.top + gap;
    else next.top = r.bottom + gap;
    setCoords(next);
  }, [expand, align, minWidthPx]);

  useLayoutEffect(() => {
    if (open) recompute();
  }, [open, recompute]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      const inTrigger = ref.current?.contains(t);
      const inMenu = menuRef.current?.contains(t);
      if (!inTrigger && !inMenu) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Capture scroll anywhere (modal bodies, page) so the popover tracks its
    // trigger; reposition on resize too.
    const onReflow = () => recompute();
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, recompute]);

  const pick = (id: T) => {
    setOpen(false);
    if (id !== value) onChange(id);
  };

  // Group consecutive items so a group header renders once.
  let lastGroup: string | undefined;

  return (
    <div
      ref={ref}
      className={cn('relative', expand ? 'w-full' : 'shrink-0', className)}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
          expand && 'w-full justify-between',
          isField
            ? cn(
                'bg-[var(--bg-primary)] text-[var(--text-primary)] border-[var(--border-color)] hover:border-[var(--border-subtle)]',
                size === 'sm'
                  ? 'h-8 px-2.5 text-[0.75rem]'
                  : 'h-9 px-3 text-[0.875rem]',
              )
            : cn(
                'px-3 font-semibold border-[var(--border-subtle)] bg-[var(--primary-subtle)] text-[var(--primary-color)] hover:brightness-110',
                size === 'sm' ? 'h-7 text-[0.75rem]' : 'h-8 text-[0.8125rem]',
              ),
          open && isField && 'border-[var(--primary-color)]',
        )}
      >
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {ActiveIcon && <ActiveIcon size={13} className="shrink-0" />}
          <span
            className={cn(
              'truncate',
              isField && !active && 'text-[var(--text-muted)]',
            )}
          >
            {triggerLabel ?? active?.label ?? placeholder ?? ''}
          </span>
        </span>
        <ChevronDown
          size={13}
          className={cn(
            'shrink-0 transition-transform duration-200',
            isField && 'text-[var(--text-muted)]',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={coords}
          className={cn(
            'animate-dropdown-pop py-1.5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-lg)] max-h-[320px] overflow-y-auto',
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === value;
            const showGroup = item.group && item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {showGroup && (
                  <div className="px-3 pt-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => pick(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                    isActive
                      ? 'bg-[var(--primary-subtle)]'
                      : 'hover:bg-[var(--bg-hover)]',
                  )}
                >
                  {Icon && (
                    <Icon
                      size={14}
                      className="mt-0.5 shrink-0"
                      style={{
                        color: isActive
                          ? 'var(--primary-color)'
                          : 'var(--text-muted)',
                      }}
                    />
                  )}
                  <span className="flex-1 min-w-0">
                    <span
                      className="block text-[0.8125rem] font-medium leading-tight truncate"
                      style={{
                        color: isActive
                          ? 'var(--primary-color)'
                          : 'var(--text-primary)',
                      }}
                    >
                      {item.label}
                    </span>
                    {item.description && (
                      <span className="block mt-0.5 text-[0.6875rem] leading-snug text-[var(--text-muted)]">
                        {item.description}
                      </span>
                    )}
                  </span>
                  {item.trailing ??
                    (isActive ? (
                      isField ? (
                        <Check
                          size={14}
                          className="mt-0.5 shrink-0"
                          style={{ color: 'var(--primary-color)' }}
                        />
                      ) : (
                        <span
                          className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: 'var(--primary-color)' }}
                          aria-hidden
                        />
                      )
                    ) : null)}
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
