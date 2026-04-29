'use client';

/**
 * RegistryPageShell — common chrome for the four host-registry tabs
 * (MCP / SKILLS / HOOK / 권한). Owns:
 *
 *   ┌─ header (sticky) ───────────────────────────────────────────┐
 *   │ [icon] Title            count   [Add]    [Refresh]          │
 *   │ {subtitle (1 line, muted)}                                  │
 *   ├─ HostRegistryBanner (slim amber chip) ──────────────────────┤
 *   │ {body — caller renders sections / cards / empty state}      │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Each tab supplies its own body content (one or more
 * `<RegistrySection>` blocks), but the chrome stays uniform so the
 * dropdown switcher's "look and feel" carries through. Stat,
 * heading, banner, error surface, and add/refresh action cluster
 * are all here so individual tabs can stop reinventing them.
 *
 * Loading state renders an indeterminate strip below the header.
 * Error state renders a dismissable amber chip just above the body.
 * Both are optional — the tab toggles them via props.
 *
 * The tab's modal (add/edit form) lives outside this shell because
 * each tab's form fields are different — see `EditorModal` in
 * @/components/layout for the modal primitive.
 */

import type { LucideIcon, ReactNode } from 'react';
import { AlertCircle, Plus, RefreshCw, X } from 'lucide-react';
import HostRegistryBanner from '@/components/env_management/HostRegistryBanner';

export interface RegistryPageShellProps {
  /** Page title, e.g. "MCP Servers". */
  title: string;
  /** Optional one-line subtitle (muted, beside the title). */
  subtitle?: ReactNode;
  /** Page-level icon shown in the heading. */
  icon: LucideIcon;
  /** "X servers" / "X skills" — rendered as a count chip next to the title. */
  countLabel?: string;
  /** Banner note — category-specific reminder. */
  bannerNote?: string;
  /** "Add" button label, e.g. "MCP 서버 추가". */
  addLabel?: string;
  /** Click handler for the primary "Add" button. Hides the button when omitted. */
  onAdd?: () => void;
  /** Click handler for the secondary "Refresh" button. */
  onRefresh?: () => void;
  /** Loading state — drives the spinner on Refresh + the indeterminate strip. */
  loading?: boolean;
  /** Optional inline error chip above the body. */
  error?: string | null;
  /** Dismiss the error chip. */
  onDismissError?: () => void;
  /** Extra header-right slot (e.g. an "enabled" toggle). */
  headerExtras?: ReactNode;
  /** Body content — usually one or more <RegistrySection>. */
  children: ReactNode;
}

export default function RegistryPageShell({
  title,
  subtitle,
  icon: Icon,
  countLabel,
  bannerNote,
  addLabel,
  onAdd,
  onRefresh,
  loading = false,
  error = null,
  onDismissError,
  headerExtras,
  children,
}: RegistryPageShellProps) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      {/* Header — sticky so scroll keeps title + actions in view. */}
      <header className="px-4 py-3 border-b border-[hsl(var(--border))] flex items-start justify-between gap-3 shrink-0 bg-[hsl(var(--card))]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Icon
              size={15}
              strokeWidth={2}
              className="text-[hsl(var(--primary))] shrink-0"
            />
            <h2 className="text-[0.9375rem] font-semibold tracking-tight text-[hsl(var(--foreground))] truncate">
              {title}
            </h2>
            {countLabel && (
              <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums px-1.5 py-0.5 rounded-md bg-[hsl(var(--muted))]/50">
                {countLabel}
              </span>
            )}
          </div>
          {subtitle && (
            <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] mt-1 truncate">
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {headerExtras}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
              />
              Refresh
            </button>
          )}
          {onAdd && (
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-500 text-white text-[0.75rem] font-medium hover:bg-violet-600 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              {addLabel ?? 'Add'}
            </button>
          )}
        </div>
      </header>

      {/* Indeterminate loading strip — same animation as TabShell. */}
      {loading && (
        <div className="relative h-0.5 bg-[hsl(var(--border))] overflow-hidden shrink-0">
          <div className="absolute inset-y-0 w-1/3 bg-[hsl(var(--primary))] animate-loading-strip" />
        </div>
      )}

      {/* Error chip — dismissable. */}
      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 shrink-0 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-red-700 dark:text-red-300 shrink-0" />
          <div className="flex-1 text-[0.75rem] text-red-700 dark:text-red-300">
            {error}
          </div>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              className="text-red-700 dark:text-red-300 hover:opacity-70 shrink-0"
              aria-label="dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Body — caller renders sections/cards. Banner sits at the top. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 space-y-4">
          {bannerNote && <HostRegistryBanner note={bannerNote} />}
          {children}
        </div>
      </div>
    </div>
  );
}
