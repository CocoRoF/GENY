'use client';

/**
 * EntityCard — the ONE canonical card shell (tone & manner source of truth).
 *
 * Absorbs the feature superset of the previous SettingsCard + RegistryCard +
 * the ad-hoc Connector/Voice/panel cards: icon tile, title/subtitle/meta,
 * status (dot or badge), tone badges, body, right-side toggle/star/actions,
 * footer actions + meta, and an optional "> Configure" expand section. Every
 * card surface renders through this so radius / surface / spacing / badge style
 * / hover stay identical app-wide. Built on existing primitives + tokens only.
 *
 * SettingsCard and RegistryCard are thin adapters over this (their public props
 * are preserved), so existing call sites are untouched.
 */

import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from './cn';

export type EntityTone =
  | 'neutral' | 'good' | 'success' | 'warn' | 'warning'
  | 'bad' | 'danger' | 'info' | 'primary';

export interface EntityBadge {
  label: ReactNode;
  tone?: EntityTone;
  icon?: LucideIcon;
}

const BADGE_TONE: Record<EntityTone, string> = {
  neutral: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))]',
  good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30',
  warning: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30',
  bad: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  danger: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  primary: 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] border-[hsl(var(--primary)/0.3)]',
};

const DOT_TONE: Record<EntityTone, string> = {
  neutral: 'bg-[var(--text-muted)]',
  good: 'bg-emerald-500', success: 'bg-emerald-500',
  warn: 'bg-amber-500', warning: 'bg-amber-500',
  bad: 'bg-rose-400', danger: 'bg-rose-400',
  info: 'bg-sky-500', primary: 'bg-[hsl(var(--primary))]',
};

export interface EntityCardProps {
  /** Icon element (e.g. <Key />). Auto-sized to 16px inside the tile. */
  icon?: ReactNode;
  iconTone?: 'neutral' | 'primary';
  title: ReactNode;
  titleMono?: boolean;
  /** Inline secondary text on the title row (e.g. "anthropic · API"). */
  meta?: ReactNode;
  /** Secondary text BELOW the title (mono, e.g. an id). */
  subtitle?: ReactNode;
  /** Status indicator on the right of the header. */
  status?: { tone: EntityTone; label: ReactNode; as?: 'dot' | 'badge' };
  /** Tone pills in the footer. */
  badges?: EntityBadge[];
  /** Body / description. */
  children?: ReactNode;
  bodyClamp?: boolean;
  /** Right-side on/off switch. */
  toggle?: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string };
  /** Favorite/star slot (rendered in the header-right cluster). */
  star?: ReactNode;
  /** Action buttons in the header-right cluster (registry style). */
  headerActions?: ReactNode;
  /** Action buttons in the footer (settings style). */
  footer?: ReactNode;
  /** Right-aligned footer meta text. */
  footerMeta?: ReactNode;
  /** Refined meta chips (cron expr, next/last fire, …) rendered below the body. */
  metaItems?: Array<{ icon?: LucideIcon; label: ReactNode; mono?: boolean; chip?: boolean }>;
  /** Action buttons pinned to the bottom-RIGHT of the card. */
  footerActions?: ReactNode;
  /** Optional "> Configure" expander. */
  expandable?: boolean;
  defaultExpanded?: boolean;
  expandLabel?: string;
  /** Fires when the Configure expander toggles (e.g. to lazy-load detail). */
  onExpandChange?: (expanded: boolean) => void;
  renderExpanded?: () => ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
  variant?: 'default' | 'muted' | 'elevated';
  /**
   * 'stack' (default) — vertical: header row (title+status) then body/meta/footer.
   * 'split' — two columns: LEFT = icon + title/desc/meta, RIGHT = status + actions.
   */
  layout?: 'stack' | 'split';
  active?: boolean;
  disabled?: boolean;
  className?: string;
}

export function EntityCard({
  icon,
  iconTone = 'primary',
  title,
  titleMono = false,
  meta,
  subtitle,
  status,
  badges,
  children,
  bodyClamp = false,
  toggle,
  star,
  headerActions,
  footer,
  footerMeta,
  metaItems,
  footerActions,
  expandable = false,
  defaultExpanded = false,
  expandLabel = 'Configure',
  onExpandChange,
  renderExpanded,
  onClick,
  ariaLabel,
  variant = 'default',
  layout = 'stack',
  active = false,
  disabled = false,
  className = '',
}: EntityCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const interactive = !!onClick && !disabled;
  const indent = icon ? 'pl-11' : '';

  const surface = cn(
    'group relative flex flex-col gap-2.5 rounded-xl border p-4 text-left transition-all duration-150',
    variant === 'muted'
      ? 'border-dashed border-[hsl(var(--border))] bg-[hsl(var(--card)/0.4)] opacity-80'
      : 'border-[hsl(var(--border))] bg-[hsl(var(--card))]',
    interactive && variant === 'elevated'
      && 'cursor-pointer hover:border-[hsl(var(--primary)/0.4)] hover:shadow-md hover:-translate-y-0.5',
    interactive && variant !== 'elevated'
      && 'cursor-pointer hover:bg-[hsl(var(--accent))] hover:border-[hsl(var(--primary)/0.35)] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary)/0.4)]',
    active && 'ring-2 ring-[hsl(var(--primary)/0.4)] border-[hsl(var(--primary)/0.4)]',
    disabled && 'opacity-60',
    className,
  );

  // Shared sub-renders (used by both layouts).
  const statusNode = status ? (
    status.as === 'badge' ? (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold border',
          BADGE_TONE[status.tone],
        )}
      >
        {status.label}
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-[0.7rem] font-medium text-[var(--text-secondary)]">
        <span className={cn('w-1.5 h-1.5 rounded-full', DOT_TONE[status.tone])} />
        {status.label}
      </span>
    )
  ) : null;

  const toggleNode = toggle ? (
    <Switch
      checked={toggle.checked}
      onCheckedChange={toggle.onChange}
      disabled={toggle.disabled}
      aria-label={toggle.label}
      onClick={(e) => e.stopPropagation()}
    />
  ) : null;

  const expanderNode = expandable ? (
    <div className={layout === 'split' ? '' : indent}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => {
            onExpandChange?.(!v);
            return !v;
          });
        }}
        className="inline-flex items-center gap-1 text-[0.75rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', expanded ? 'rotate-0' : '-rotate-90')} />
        {expandLabel}
      </button>
      {expanded && renderExpanded && <div className="mt-3">{renderExpanded()}</div>}
    </div>
  ) : null;

  const titleRow = (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        className={cn(
          'font-semibold text-[0.875rem] leading-tight truncate text-[hsl(var(--foreground))]',
          titleMono && 'font-mono',
        )}
      >
        {title}
      </span>
      {meta && (
        <span className="text-[0.7rem] text-[var(--text-tertiary)] inline-flex items-center gap-1.5">{meta}</span>
      )}
    </div>
  );

  const subtitleNode = subtitle ? (
    <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] truncate font-mono mt-0.5">{subtitle}</div>
  ) : null;

  const bodyNode =
    children != null && children !== false ? (
      <div className={cn('text-[0.8125rem] text-[hsl(var(--muted-foreground))] leading-relaxed break-words', bodyClamp && 'line-clamp-2')}>
        {children}
      </div>
    ) : null;

  const metaItemsNode =
    metaItems && metaItems.length > 0 ? (
      <div className="flex items-center gap-2 flex-wrap text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
        {metaItems.map((m, i) => {
          const MIcon = m.icon;
          return (
            <span
              key={i}
              className={cn(
                'inline-flex items-center gap-1',
                m.mono && 'font-mono',
                m.chip && 'px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] border border-[hsl(var(--border))]',
              )}
            >
              {MIcon && <MIcon className="w-3 h-3 opacity-70" />}
              {m.label}
            </span>
          );
        })}
      </div>
    ) : null;

  const iconNode = icon ? (
    <span
      className={cn(
        'inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0 [&>svg]:w-4 [&>svg]:h-4',
        iconTone === 'primary'
          ? 'bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]'
          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
      )}
    >
      {icon}
    </span>
  ) : null;

  // ── SPLIT layout: LEFT (icon + title/desc/meta) | RIGHT (status + actions) ──
  if (layout === 'split') {
    return (
      <div
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={interactive ? onClick : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick?.();
                }
              }
            : undefined
        }
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        className={surface}
      >
        <div className="flex items-start gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {iconNode}
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              {titleRow}
              {subtitleNode}
              {bodyNode}
              {metaItemsNode}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            {(statusNode || star || headerActions || toggleNode) && (
              <div className="flex items-center gap-1.5">
                {statusNode}
                {star}
                {headerActions}
                {toggleNode}
              </div>
            )}
            {footerActions && <div className="flex items-center gap-1">{footerActions}</div>}
          </div>
        </div>
        {expanderNode}
      </div>
    );
  }

  // ── STACK layout (default) ──
  // Use div+role (not <button>) so nested action buttons / toggles inside the
  // card stay valid HTML (a <button> can't contain a <button>).
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={surface}
    >
      {/* ── Header ── */}
      <div className="flex items-start gap-3">
        {icon && (
          <span
            className={cn(
              'inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0 [&>svg]:w-4 [&>svg]:h-4',
              iconTone === 'primary'
                ? 'bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
            )}
          >
            {icon}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                'font-semibold text-[0.875rem] leading-tight truncate text-[hsl(var(--foreground))]',
                titleMono && 'font-mono',
              )}
            >
              {title}
            </span>
            {meta && (
              <span className="text-[0.7rem] text-[var(--text-tertiary)] inline-flex items-center gap-1.5">
                {meta}
              </span>
            )}
          </div>
          {subtitle && (
            <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] truncate font-mono mt-0.5">
              {subtitle}
            </div>
          )}
        </div>

        {/* right cluster */}
        {(status || toggle || star || headerActions) && (
          <div className="flex items-center gap-1.5 shrink-0">
            {status && status.as !== 'badge' && (
              <span className="flex items-center gap-1.5 text-[0.7rem] font-medium text-[var(--text-secondary)]">
                <span className={cn('w-1.5 h-1.5 rounded-full', DOT_TONE[status.tone])} />
                {status.label}
              </span>
            )}
            {status && status.as === 'badge' && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold border',
                  BADGE_TONE[status.tone],
                )}
              >
                {status.label}
              </span>
            )}
            {star}
            {headerActions}
            {toggle && (
              <Switch
                checked={toggle.checked}
                onCheckedChange={toggle.onChange}
                disabled={toggle.disabled}
                aria-label={toggle.label}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Body ── */}
      {children != null && children !== false && (
        <div
          className={cn(
            'text-[0.8125rem] text-[hsl(var(--muted-foreground))] leading-relaxed break-words',
            bodyClamp && 'line-clamp-2',
            indent,
          )}
        >
          {children}
        </div>
      )}

      {/* ── Refined meta chips (cron / next / last …) ── */}
      {metaItems && metaItems.length > 0 && (
        <div className={cn('flex items-center gap-2 flex-wrap text-[0.6875rem] text-[hsl(var(--muted-foreground))]', indent)}>
          {metaItems.map((m, i) => {
            const MIcon = m.icon;
            return (
              <span
                key={i}
                className={cn(
                  'inline-flex items-center gap-1',
                  m.mono && 'font-mono',
                  m.chip &&
                    'px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] border border-[hsl(var(--border))]',
                )}
              >
                {MIcon && <MIcon className="w-3 h-3 opacity-70" />}
                {m.label}
              </span>
            );
          })}
        </div>
      )}

      {/* ── Badges + footer meta ── */}
      {(badges?.length || footerMeta) && (
        <div className={cn('flex items-center justify-between gap-2 flex-wrap mt-auto', indent)}>
          <div className="flex items-center gap-1 flex-wrap">
            {badges?.map((b, i) => {
              const BIcon = b.icon;
              return (
                <span
                  key={i}
                  className={cn(
                    'inline-flex items-center gap-1 text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold border',
                    BADGE_TONE[b.tone ?? 'neutral'],
                  )}
                >
                  {BIcon && <BIcon className="w-2.5 h-2.5" />}
                  {b.label}
                </span>
              );
            })}
          </div>
          {footerMeta && (
            <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums shrink-0">
              {footerMeta}
            </span>
          )}
        </div>
      )}

      {/* ── Footer: left info/actions + right-pinned actions ── */}
      {((footer != null && footer !== false) || footerActions) && (
        <div className={cn('flex items-center justify-between gap-2 flex-wrap', indent)}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{footer}</div>
          {footerActions && <div className="flex items-center gap-1 ml-auto">{footerActions}</div>}
        </div>
      )}

      {/* ── Configure expander ── */}
      {expandable && (
        <div className={indent}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => {
                onExpandChange?.(!v);
                return !v;
              });
            }}
            className="inline-flex items-center gap-1 text-[0.75rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', expanded ? 'rotate-0' : '-rotate-90')} />
            {expandLabel}
          </button>
          {expanded && renderExpanded && <div className="mt-3">{renderExpanded()}</div>}
        </div>
      )}
    </div>
  );
}

/** Responsive grid for EntityCards (1 / md:2 / xl:3 by default). */
export function EntityCardGrid({
  children,
  xlCols = 3,
  className = '',
}: {
  children: ReactNode;
  xlCols?: 2 | 3 | 4;
  className?: string;
}) {
  const xl = xlCols === 2 ? 'xl:grid-cols-2' : xlCols === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3';
  return <div className={cn('grid grid-cols-1 md:grid-cols-2 gap-2.5', xl, className)}>{children}</div>;
}

export default EntityCard;
