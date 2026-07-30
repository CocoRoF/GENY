'use client';

/**
 * SegmentButton — THE segment pill. SubTabNav (tab strips) and
 * SegmentedControl (inline toggles) both render this exact component,
 * so the two surfaces cannot drift apart: accent pill + primary
 * underline when active, ghost text otherwise.
 */

import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from './cn';

export interface SegmentButtonProps {
  label: ReactNode;
  active: boolean;
  onClick: () => void;
  icon?: LucideIcon;
  count?: number;
  title?: string;
}

export function SegmentButton({
  label,
  active,
  onClick,
  icon: Icon,
  count,
  title,
}: SegmentButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
        active
          ? 'text-[hsl(var(--foreground))] bg-[hsl(var(--accent))]'
          : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]',
      )}
    >
      {Icon && (
        <Icon
          size={11}
          className={active ? 'text-[hsl(var(--primary))]' : 'opacity-70'}
        />
      )}
      <span>{label}</span>
      {count !== undefined && (
        <span className="text-[hsl(var(--muted-foreground))] text-[0.625rem]">
          ({count})
        </span>
      )}
      {active && (
        <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-sm bg-[hsl(var(--primary))]" />
      )}
    </button>
  );
}

export default SegmentButton;
