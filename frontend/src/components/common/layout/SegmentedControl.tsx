'use client';

/**
 * SegmentedControl — inline view/mode switch: every option visible, the
 * active one emphasized.
 *
 * Visual family: same pill treatment as SubTabNav (the 환경 탭
 * Manifest/Tools/Workspace strip) — active segment gets the accent pill
 * with a soft primary border, inactive segments are ghost text. Unlike
 * SubTabNav this is an INLINE control (no full-width bar / underline),
 * sized h-8 so it sits flush in unified toolbar rows next to
 * IconButton / ActionButton / Selector.
 */

import { LucideIcon } from 'lucide-react';
import { cn } from './cn';

export interface SegmentDef<T extends string = string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  title?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  items: SegmentDef<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  ariaLabel?: string;
}

export function SegmentedControl<T extends string = string>({
  items,
  value,
  onChange,
  className,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center h-8 gap-0.5 shrink-0', className)}
    >
      {items.map(({ id, label, icon: Icon, title }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            title={title}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
              active
                ? 'text-[hsl(var(--foreground))] bg-[hsl(var(--accent))] border border-[hsl(var(--primary))/30]'
                : 'text-[hsl(var(--muted-foreground))] border border-transparent hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]',
            )}
          >
            {Icon && (
              <Icon
                size={12}
                className={active ? 'text-[hsl(var(--primary))]' : 'opacity-70'}
              />
            )}
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
