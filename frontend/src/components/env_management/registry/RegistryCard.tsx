'use client';

/**
 * RegistryCard — uniform item card for host-registry tabs.
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [icon] {title}                          [★] [edit] │
 *   │ {subtitle (mono, muted)}                            │
 *   │                                                     │
 *   │ {description — line-clamp 2}                        │
 *   │                                                     │
 *   │ [badge] [badge] [badge]              {meta footer} │
 *   └─────────────────────────────────────────────────────┘
 *
 * Slot model (vs prop spread): caller passes the ★ toggle,
 * action buttons, and badges already-rendered. The card is just
 * structural — spacing, hover state, optional click target. This
 * keeps the card framework-agnostic to the underlying registry's
 * data shape (a hook entry has very different fields than a skill).
 *
 * Variants:
 *
 *   - default — full bleed, primary border on hover
 *   - muted   — opacity-60, no hover lift; for read-only entries
 *               (bundled skills, external permission rules)
 *
 * Accessibility: when `onClick` is provided the wrapper becomes a
 * button; otherwise it stays a div so the action buttons inside
 * stay independently focusable.
 */

import type { LucideIcon, ReactNode } from 'react';

export interface RegistryCardBadge {
  label: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'info' | 'danger';
  /** Optional small icon. */
  icon?: LucideIcon;
}

export interface RegistryCardProps {
  /** Icon shown on the left of the title. */
  icon?: LucideIcon;
  /** Card title (e.g. skill id, server name, hook event). */
  title: ReactNode;
  /** Render title in font-mono? Useful for ids / paths. */
  titleMono?: boolean;
  /** Optional one-line subtitle below the title. */
  subtitle?: ReactNode;
  /** Multi-line description (line-clamped to 2 lines). */
  description?: ReactNode;
  /** Status / capability badges below description. */
  badges?: RegistryCardBadge[];
  /** ★ env-default toggle — pre-rendered by caller. */
  star?: ReactNode;
  /** Edit/delete/etc action buttons — rendered next to the star. */
  actions?: ReactNode;
  /** Inline footer line (e.g. "3 tools", "120ms"). */
  meta?: ReactNode;
  /** Visual emphasis. */
  variant?: 'default' | 'muted';
  /** Click handler — wraps the card in a button if provided. */
  onClick?: () => void;
  /** Active/selected ring. */
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
    'group relative flex flex-col gap-2 p-3 rounded-lg border transition-colors text-left',
    variant === 'muted'
      ? 'border-dashed border-[hsl(var(--border))] bg-[hsl(var(--card))]/40 opacity-75'
      : 'border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/0.4)] hover:shadow-sm',
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
      {/* ── Header row: icon + title + actions ── */}
      <div className="flex items-start gap-2">
        {Icon && (
          <Icon
            size={14}
            strokeWidth={2}
            className="mt-0.5 text-[hsl(var(--primary))] shrink-0"
          />
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
          <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-1">
            {star}
            {actions}
          </div>
        )}
      </div>

      {/* ── Description ── */}
      {description && (
        <div className="text-[0.75rem] text-[hsl(var(--muted-foreground))] line-clamp-2 leading-relaxed">
          {description}
        </div>
      )}

      {/* ── Badges + meta ── */}
      {(badges?.length || meta) && (
        <div className="flex items-center justify-between gap-2 flex-wrap mt-auto">
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
