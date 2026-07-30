'use client';

/**
 * SegmentedControl — inline view/mode switch: every option visible, the
 * active one emphasized.
 *
 * Renders the SAME SegmentButton component as SubTabNav (the 환경 탭
 * tab strip), so the two can never drift apart. The only difference is
 * the container: an inline h-8 group (no full-width bar / bottom
 * border) that sits flush in unified toolbar rows next to IconButton /
 * ActionButton / Selector.
 */

import { LucideIcon } from 'lucide-react';
import { cn } from './cn';
import { SegmentButton } from './SegmentButton';

export interface SegmentDef<T extends string = string> {
  id: T;
  label: string;
  /** Optional — convention is label-only segments; the interface stays
   *  open for surfaces that need the icon treatment. */
  icon?: LucideIcon;
  count?: number;
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
      {items.map(({ id, label, icon, count, title }) => (
        <SegmentButton
          key={id}
          label={label}
          icon={icon}
          count={count}
          title={title}
          active={id === value}
          onClick={() => onChange(id)}
        />
      ))}
    </div>
  );
}

export default SegmentedControl;
