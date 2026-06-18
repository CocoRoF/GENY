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

import { useEffect, useRef, useState, type ReactNode } from 'react';
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

  const isField = variant === 'field';
  const expand = fullWidth ?? isField; // field defaults full-width

  const active = items.find((i) => i.id === value);
  const ActiveIcon = active?.icon;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
            ? 'h-9 px-3 text-[0.875rem] bg-[var(--bg-primary)] text-[var(--text-primary)] border-[var(--border-color)] hover:border-[var(--border-subtle)]'
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

      {open && (
        <div
          role="menu"
          style={minWidthPx ? { minWidth: minWidthPx } : undefined}
          className={cn(
            'animate-dropdown-pop absolute top-full mt-1.5 z-40 py-1.5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-lg)] max-h-[320px] overflow-y-auto',
            expand ? 'left-0 right-0' : align === 'end' ? 'right-0' : 'left-0',
            !expand && !minWidthPx && 'min-w-[200px]',
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
        </div>
      )}
    </div>
  );
}
