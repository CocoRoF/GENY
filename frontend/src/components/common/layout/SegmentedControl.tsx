'use client';

/**
 * SegmentedControl — inline view/mode switch: every option visible, the
 * active one emphasized.
 *
 * The segment buttons are VERBATIM copies of SubTabNav's tab buttons
 * (the 환경 탭 Manifest/Tools/Workspace strip): accent pill + primary
 * underline when active, ghost text otherwise. If SubTabNav's visual
 * changes, mirror it here — the two must stay identical. The only
 * difference is the container: this is an inline h-8 group (no
 * full-width bar / bottom border) so it sits flush in unified toolbar
 * rows next to IconButton / ActionButton / Selector.
 */

import { LucideIcon } from 'lucide-react';
import { cn } from './cn';

export interface SegmentDef<T extends string = string> {
  id: T;
  label: string;
  /** Optional — convention is label-only segments; the interface stays
   *  open for surfaces that need the SubTabNav icon treatment. */
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
        const isActive = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={title}
            onClick={() => onChange(id)}
            className={cn(
              'relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
              isActive
                ? 'text-[hsl(var(--foreground))] bg-[hsl(var(--accent))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]',
            )}
          >
            {Icon && (
              <Icon
                size={11}
                className={
                  isActive ? 'text-[hsl(var(--primary))]' : 'opacity-70'
                }
              />
            )}
            <span>{label}</span>
            {isActive && (
              <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-sm bg-[hsl(var(--primary))]" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
