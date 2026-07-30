'use client';

/**
 * SegmentedControl — the standard "both options visible, active one
 * filled" toggle (same look as the header's ENG/KOR switch, promoted to
 * a common component). h-8 outer box so it sits flush in unified
 * toolbar rows next to IconButton / ActionButton / Selector.
 */

import { cn } from './cn';

export interface SegmentDef<T extends string = string> {
  id: T;
  label: string;
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
      className={cn(
        'inline-flex items-stretch h-8 gap-0.5 p-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] shrink-0',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={item.title}
            onClick={() => onChange(item.id)}
            className={cn(
              'px-2.5 inline-flex items-center text-[0.75rem] font-medium rounded transition-all duration-150 border-none cursor-pointer whitespace-nowrap',
              active
                ? 'bg-[var(--primary-color)] text-white shadow-sm'
                : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
