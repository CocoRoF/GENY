'use client';

/**
 * RegistryFormShell — outer chrome for the create/edit views of the
 * four host-registry tabs (MCP / SKILLS / HOOK / 권한). Mirrors the
 * hero layout of `RegistryPageShell` so list view and form view read
 * as two states of the same surface, not a modal popping over a page.
 *
 *   ┌─ hero ─────────────────────────────────────────────────────────┐
 *   │ [icon]  Title                                [extras]  [Back] │
 *   │         {subtitle}                                              │
 *   ├─ optional banner / error chip ─────────────────────────────────┤
 *   ├─ body (max-width, padded) ─────────────────────────────────────┤
 *   │ {children — form sections}                                     │
 *   └─ footer (sticky at bottom) ────────────────────────────────────┘
 *      {footer — Cancel / Save / Test buttons live here}
 *
 * Cycle 20260430 Phase 9.8 — replaces the modal overlay UX. Operators
 * complained that "create" felt like a context switch inside an
 * already-busy IDE. The shell renders inline so the form view is just
 * a different mode of the same tab pane.
 */

import type { ReactNode } from 'react';
import { ArrowLeft, X, AlertCircle, type LucideIcon } from 'lucide-react';

export interface RegistryFormShellProps {
  /** Page-level icon — rendered in a tinted rounded tile. */
  icon: LucideIcon;
  /** Page title, e.g. "새 MCP 서버" or "MCP 서버 편집". */
  title: string;
  /** Optional description / subtitle below the title. */
  subtitle?: ReactNode;
  /** Back-to-list label. Defaults to a generic localised string when
   *  omitted. */
  backLabel: string;
  /** Click handler for the back-to-list button. */
  onBack: () => void;
  /** Right-of-actions slot for form-level controls (e.g. mode
   *  toggles, test status chip). Sits between the extras area and
   *  the back button. */
  headerExtras?: ReactNode;
  /** Banner note — slim info chip below the hero. */
  bannerNote?: ReactNode;
  /** Form-level error to surface in a red dismissable banner. */
  error?: string | null;
  onDismissError?: () => void;
  /** Body content — typically a stack of form sections. */
  children: ReactNode;
  /** Sticky footer slot — Cancel / Save / Test buttons live here. */
  footer?: ReactNode;
}

export default function RegistryFormShell({
  icon: Icon,
  title,
  subtitle,
  backLabel,
  onBack,
  headerExtras,
  bannerNote,
  error,
  onDismissError,
  children,
  footer,
}: RegistryFormShellProps) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto px-6 py-8 flex flex-col gap-6">
          {/* ── Hero ── */}
          <header className="flex items-start gap-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[hsl(var(--primary)/0.1)] shrink-0 mt-0.5">
              <Icon className="w-6 h-6 text-[hsl(var(--primary))]" strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[1.25rem] font-semibold tracking-tight text-[hsl(var(--foreground))] truncate">
                {title}
              </h2>
              {subtitle && (
                <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1 leading-relaxed">
                  {subtitle}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0 mt-1">
              {headerExtras}
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
                title={backLabel}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {backLabel}
              </button>
            </div>
          </header>

          {/* ── Banner ── */}
          {bannerNote && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-sky-500/25 bg-sky-500/5 text-[0.7rem] text-sky-800 dark:text-sky-300 leading-relaxed">
              <div className="flex-1 min-w-0">{bannerNote}</div>
            </div>
          )}

          {/* ── Error chip ── */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10">
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

          {/* ── Body (form sections) ── */}
          <div className="flex flex-col gap-5">{children}</div>
        </div>
      </div>

      {/* ── Footer ── */}
      {footer && (
        <footer className="border-t border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 backdrop-blur-sm shrink-0">
          <div className="max-w-[1200px] mx-auto px-6 py-3 flex items-center gap-2">
            {footer}
          </div>
        </footer>
      )}
    </div>
  );
}
