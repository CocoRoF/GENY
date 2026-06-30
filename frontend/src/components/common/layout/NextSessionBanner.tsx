'use client';

/**
 * NextSessionBanner — small persistent info strip that explains the
 * "next-session apply" semantics for settings written in the Library
 * and Session-Env tabs.
 *
 * Settings written here (permissions, hooks, skills, MCP, framework
 * config, manifest stages) are read by the executor at session-build
 * time. Active sessions hold a frozen runtime snapshot via
 * ``Pipeline.attach_runtime``; mutations to the on-disk file have no
 * effect on them. The banner records this semantics so the user
 * doesn't conclude the UI is broken when an active session ignores a
 * just-saved change.
 *
 * Live-reload (cycle 20260426_1 sprint E.1) is the actionable answer
 * once it ships; until then this banner is the only signal.
 */

import { Info } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export interface NextSessionBannerProps {
  /** When set, replaces the default copy with the i18n key namespace
   * (e.g. "nextSessionBanner.sessionScope"). Use to swap the copy for
   * the session-scoped Environment tab where the framing is slightly
   * different. */
  variant?: 'library' | 'session';
}

export function NextSessionBanner({ variant = 'library' }: NextSessionBannerProps) {
  const { t } = useI18n();
  const titleKey =
    variant === 'session'
      ? 'nextSessionBanner.session.title'
      : 'nextSessionBanner.library.title';
  const bodyKey =
    variant === 'session'
      ? 'nextSessionBanner.session.body'
      : 'nextSessionBanner.library.body';
  return (
    <div
      role="note"
      className="shrink-0 px-4 py-2 border-b border-[var(--border-color)] bg-[hsl(var(--muted))] text-[0.75rem] text-[var(--text-secondary)] flex items-start gap-2"
    >
      <Info size={13} className="text-[var(--text-muted)] mt-[1px] shrink-0" />
      <div className="leading-snug">
        <span className="font-medium text-[var(--text-primary)] mr-1">
          {t(titleKey)}
        </span>
        <span>{t(bodyKey)}</span>
      </div>
    </div>
  );
}

export default NextSessionBanner;
