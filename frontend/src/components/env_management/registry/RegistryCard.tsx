'use client';

/**
 * RegistryCard — uniform item card for host-registry tabs.
 *
 * Cycle 20260429 Phase 8.1 — bumped the visual weight to match
 * the env welcome card: rounded-xl corners, soft shadow on hover,
 * tinted icon tile, breathing room. Operator's read on the
 * previous slim-bordered version was "flat / cheap".
 *
 *   ┌─ rounded-xl, hover lifts ─────────────────────────────────────┐
 *   │ [icon-tile]   {title}                          [★] [edit] [✕]│
 *   │               {subtitle}                                       │
 *   │               {description}                                    │
 *   │                                                                │
 *   │ [badge] [badge]                              {meta footer}    │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Slot model: caller passes star toggle, action buttons, and badges
 * already-rendered. The card is structural — typography, spacing,
 * hover treatment.
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface RegistryCardBadge {
  label: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'info' | 'danger';
  icon?: LucideIcon;
}

export interface RegistryCardProps {
  icon?: LucideIcon;
  title: ReactNode;
  titleMono?: boolean;
  subtitle?: ReactNode;
  description?: ReactNode;
  badges?: RegistryCardBadge[];
  star?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  variant?: 'default' | 'muted';
  onClick?: () => void;
  active?: boolean;
}

const TONE_CLASS: Record<NonNullable<RegistryCardBadge['tone']>, string> = {
  neutral:
    'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))]',
  good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30',
  danger:
    'bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30',
};

export default function RegistryCard({
  icon: Icon,
  title,
  titleMono = false,
  subtitle,
  description,
  badges,
  star,
  actions,
  meta,
  variant = 'default',
  onClick,
  active = false,
}: RegistryCardProps) {
  const wrapperClass = [
    'group relative flex flex-col gap-2.5 p-4 rounded-xl border transition-all text-left',
    variant === 'muted'
      ? 'border-dashed border-[hsl(var(--border))] bg-[hsl(var(--card))]/40 opacity-80'
      : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/0.4)] hover:shadow-md hover:-translate-y-0.5',
    active ? 'ring-2 ring-violet-500/40 border-violet-500/40' : '',
    onClick ? 'cursor-pointer' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const Tag: 'button' | 'div' = onClick ? 'button' : 'div';

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={wrapperClass}
    >
      <div className="flex items-start gap-3">
        {Icon && (
          <div className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[hsl(var(--primary)/0.1)] shrink-0">
            <Icon
              className="w-4 h-4 text-[hsl(var(--primary))]"
              strokeWidth={2}
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div
            className={`text-[0.875rem] font-semibold text-[hsl(var(--foreground))] truncate ${
              titleMono ? 'font-mono' : ''
            }`}
          >
            {title}
          </div>
          {subtitle && (
            <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] truncate font-mono mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
        {(star || actions) && (
          <div className="flex items-center gap-0.5 shrink-0 -mr-1">
            {star}
            {actions}
          </div>
        )}
      </div>

      {description && (
        <div className="text-[0.75rem] text-[hsl(var(--muted-foreground))] line-clamp-2 leading-relaxed pl-11">
          {description}
        </div>
      )}

      {(badges?.length || meta) && (
        <div className="flex items-center justify-between gap-2 flex-wrap pl-11 mt-auto">
          <div className="flex items-center gap-1 flex-wrap">
            {badges?.map((badge, i) => {
              const BIcon = badge.icon;
              return (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${
                    TONE_CLASS[badge.tone ?? 'neutral']
                  }`}
                >
                  {BIcon && <BIcon className="w-2.5 h-2.5" />}
                  {badge.label}
                </span>
              );
            })}
          </div>
          {meta && (
            <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums shrink-0">
              {meta}
            </span>
          )}
        </div>
      )}
    </Tag>
  );
}
