'use client';

/**
 * SettingsCard — the shared card shell for the Settings surfaces.
 *
 * Deliberately restrained: a neutral icon tile, one small status dot (the only
 * colour), muted meta text, and a subtle hover — no bright tinted tiles, no
 * lift/shadow. Use it everywhere a settings panel needs a card so the whole
 * surface reads consistently.
 *
 *   <SettingsCard
 *     icon={<Key />}
 *     title="Anthropic"
 *     meta={<><span className="font-mono">anthropic</span> · API</>}
 *     status={{ tone: 'good', label: '준비됨' }}
 *     onClick={...}
 *     footer={<button>…</button>}
 *   >
 *     ANTHROPIC_API_KEY configured.
 *   </SettingsCard>
 */

import type { ReactNode } from 'react';

export type CardStatusTone = 'good' | 'warn' | 'bad' | 'neutral';

const DOT_CLASS: Record<CardStatusTone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-400',
  neutral: 'bg-[var(--text-muted)]',
};

export interface SettingsCardProps {
  title: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  status?: { tone: CardStatusTone; label: ReactNode };
  children?: ReactNode;
  footer?: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
  className?: string;
}

export function SettingsCard({
  title,
  icon,
  meta,
  status,
  children,
  footer,
  onClick,
  ariaLabel,
  className = '',
}: SettingsCardProps) {
  const interactive = !!onClick;
  // Body/footer indent aligns under the icon (w-9 = 2.25rem + gap-3 = 0.75rem).
  const indent = icon ? 'pl-[3rem]' : '';

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
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
      className={
        'rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] ' +
        'p-4 flex flex-col gap-2.5 text-left transition-colors duration-150 ' +
        (interactive
          ? 'cursor-pointer hover:bg-[var(--bg-hover)] hover:border-[var(--text-tertiary)]/45 ' +
            'focus:outline-none focus:ring-1 focus:ring-[var(--primary-color)]/40 '
          : '') +
        className
      }
    >
      <div className="flex items-center gap-3">
        {icon && (
          <span className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0 bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            {icon}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-[0.9rem] leading-tight truncate text-[var(--text-primary)]">
              {title}
            </span>
            {meta && (
              <span className="text-[0.7rem] text-[var(--text-tertiary)] inline-flex items-center gap-1.5">
                {meta}
              </span>
            )}
          </div>
        </div>
        {status && (
          <span className="flex items-center gap-1.5 shrink-0 text-[0.7rem] font-medium text-[var(--text-secondary)]">
            <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[status.tone]}`} />
            {status.label}
          </span>
        )}
      </div>

      {children != null && children !== false && (
        <div
          className={`text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed break-words ${indent}`}
        >
          {children}
        </div>
      )}

      {footer != null && footer !== false && (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${indent}`}>
          {footer}
        </div>
      )}
    </div>
  );
}
