'use client';

/**
 * RegistrySection — group header + optional grid wrapper.
 *
 * Hooks group entries by event ("pre_tool_use", "post_run", ...);
 * skills group bundled vs user; permissions stay flat. The header
 * is consistent across all four tabs:
 *
 *   ┌─ {LABEL} ({count}) ────────────────────────────────────────
 *   │ {description if any}
 *   │
 *   │ {grid of cards}
 *
 * Pass `inline` when the section is one row only (e.g. a single
 * card under the heading) — grid wrapper is suppressed.
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import RegistryGrid from './RegistryGrid';

export interface RegistrySectionProps {
  /** Section title — will be UPPERCASED visually. */
  label: ReactNode;
  /** Optional count chip next to the label. */
  count?: number;
  /** Optional one-line description below the label. */
  description?: ReactNode;
  /** Optional icon next to the label. */
  icon?: LucideIcon;
  /** Right-aligned slot in the section header (e.g. "Select all"). */
  rightSlot?: ReactNode;
  /** Skip the grid wrapper for callers that have a custom layout. */
  inline?: boolean;
  children: ReactNode;
}

export default function RegistrySection({
  label,
  count,
  description,
  icon: Icon,
  rightSlot,
  inline = false,
  children,
}: RegistrySectionProps) {
  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-2">
        <div className="flex items-center gap-2">
          {Icon && (
            <Icon
              size={12}
              className="text-[hsl(var(--muted-foreground))] shrink-0"
            />
          )}
          <h3 className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
            {label}
            {typeof count === 'number' && (
              <span className="ml-1.5 font-normal tabular-nums">({count})</span>
            )}
          </h3>
          {description && (
            <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
              · {description}
            </span>
          )}
        </div>
        {rightSlot && <div className="shrink-0">{rightSlot}</div>}
      </div>
      {inline ? children : <RegistryGrid>{children}</RegistryGrid>}
    </section>
  );
}
