'use client';

/**
 * Selector — the reusable dropdown switcher (the env-management nav
 * pattern, promoted to a first-party primitive). A trigger button shows
 * the active item; clicking opens a popover list of items, each with an
 * icon + label + optional description + an active marker.
 *
 * Fully theme-token based, so it follows light/dark correctly (the
 * original used raw violet-500/300 utilities that looked off in dark).
 *
 * Usage:
 *   <Selector
 *     items={[{ id: 'a', label: 'Alpha', description: '…', icon: Layers }]}
 *     value={tab}
 *     onChange={setTab}
 *   />
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectorItem<T extends string = string> {
  id: T;
  label: string;
  description?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Optional right-aligned node (count badge, etc.). Replaces the
   *  default active dot when present. */
  trailing?: ReactNode;
}

export interface SelectorProps<T extends string = string> {
  items: SelectorItem<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: 'sm' | 'md';
  /** Popover edge alignment relative to the trigger. */
  align?: 'start' | 'end';
  minWidthPx?: number;
  /** Override the trigger's label (defaults to the active item's label). */
  triggerLabel?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export default function Selector<T extends string = string>({
  items,
  value,
  onChange,
  size = 'md',
  align = 'start',
  minWidthPx = 220,
  triggerLabel,
  className,
  ariaLabel,
}: SelectorProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const active = items.find((i) => i.id === value) ?? items[0];
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

  return (
    <div ref={ref} className={cn('relative shrink-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 rounded-md font-semibold border transition-colors',
          'border-[var(--border-subtle)] bg-[var(--primary-subtle)] text-[var(--primary-color)] hover:brightness-110',
          size === 'sm' ? 'h-7 text-[0.75rem]' : 'h-8 text-[0.8125rem]',
        )}
      >
        {ActiveIcon && <ActiveIcon size={13} />}
        <span className="truncate">{triggerLabel ?? active?.label}</span>
        <ChevronDown
          size={13}
          className={cn('transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          role="menu"
          style={{ minWidth: minWidthPx }}
          className={cn(
            'animate-dropdown-pop absolute top-full mt-1.5 z-40 py-1.5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-lg)]',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === value;
            return (
              <button
                key={item.id}
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
                    className="block text-[0.8125rem] font-medium leading-tight"
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
                    <span
                      className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: 'var(--primary-color)' }}
                      aria-hidden
                    />
                  ) : null)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
