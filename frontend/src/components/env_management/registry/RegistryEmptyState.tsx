'use client';

/**
 * RegistryEmptyState — centered empty state for registries with no
 * entries. Surfaces the primary action prominently so the operator
 * always knows what to do next.
 *
 *   ┌─ centered card ──────────────────────────────────────┐
 *   │       (large icon)                                   │
 *   │                                                       │
 *   │       {title}                                         │
 *   │       {hint}                                          │
 *   │                                                       │
 *   │       [+ Add entity]                                  │
 *   └───────────────────────────────────────────────────────┘
 *
 * Mirrors the env welcome card's centered-with-CTA pattern so the
 * registry tabs read at the same polish level when bare.
 */

import type { LucideIcon } from 'react';
import { Plus } from 'lucide-react';

export interface RegistryEmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  /** Primary CTA label. */
  addLabel?: string;
  onAdd?: () => void;
}

export default function RegistryEmptyState({
  icon: Icon,
  title,
  hint,
  addLabel,
  onAdd,
}: RegistryEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 rounded-lg border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--card))]/40">
      <div className="w-12 h-12 rounded-full bg-violet-500/10 flex items-center justify-center text-violet-500">
        <Icon className="w-6 h-6" />
      </div>
      <div className="text-center">
        <div className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
          {title}
        </div>
        {hint && (
          <div className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1 leading-relaxed max-w-md">
            {hint}
          </div>
        )}
      </div>
      {onAdd && addLabel && (
        <button
          type="button"
          onClick={onAdd}
          className="mt-2 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-violet-500 text-white text-[0.8125rem] font-medium hover:bg-violet-600 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {addLabel}
        </button>
      )}
    </div>
  );
}
