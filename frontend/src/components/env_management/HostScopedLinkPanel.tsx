'use client';

/**
 * HostScopedLinkPanel — placeholder body for the four host-scoped
 * Globals sub-tabs (MCP / Hooks / Permissions / Skills).
 *
 * These four areas live OUTSIDE the environment manifest — they're
 * shared across every environment and edited via the Library tab.
 * The Globals view exposes them so the user has a single index of
 * "everything that touches this environment", and renders this
 * placeholder until Phase 3 inlines the full editors.
 */

import type { ComponentType, ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export interface HostScopedLinkPanelProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  hostBadge?: boolean;
  primaryActionLabel: string;
  onPrimaryAction: () => void;
  /** Optional inline content rendered above the action — bullets,
   *  stat blocks, anything. */
  children?: ReactNode;
}

export default function HostScopedLinkPanel({
  icon: Icon,
  title,
  description,
  hostBadge = true,
  primaryActionLabel,
  onPrimaryAction,
  children,
}: HostScopedLinkPanelProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-md bg-[hsl(var(--primary)/0.08)] shrink-0">
          <Icon className="w-5 h-5 text-[hsl(var(--primary))]" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
              {title}
            </h3>
            {hostBadge && (
              <span className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                {t('envManagement.globals.hostBadge')}
              </span>
            )}
          </div>
          <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1 leading-relaxed">
            {description}
          </p>
        </div>
      </header>

      {children}

      <div className="pt-2 border-t border-[hsl(var(--border))]">
        <button
          type="button"
          onClick={onPrimaryAction}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] hover:border-[hsl(var(--primary)/0.4)] transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          {primaryActionLabel}
        </button>
      </div>
    </div>
  );
}
