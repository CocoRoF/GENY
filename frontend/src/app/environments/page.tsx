'use client';

/**
 * /environments — dedicated page for the visual 21-stage environment
 * builder.
 *
 * Cycle 20260427_2 PR-1 split the surface from the dev-mode tab system;
 * PR-2 redesigned the layout to be canvas-first. The page wrapper is
 * minimal: it owns the post-save redirect + a Suspense boundary that
 * Next.js 16 requires around the shell's `useSearchParams()` call
 * (Cycle 20260429 Phase 2 introduced `?tab=` for the 5-tab header).
 *
 * Without the Suspense, `next build` fails the prerender step with
 * "useSearchParams() should be wrapped in a suspense boundary"
 * because the static generation pass cannot resolve query params.
 * The fallback is a thin loader — search-param-dependent body
 * (CompactMetaBar / registry tabs) hydrates client-side once the
 * URL is known.
 */

import { Suspense } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import EnvManagementShell from '@/components/env_management/EnvManagementShell';

export default function EnvironmentManagementPage() {
  const { t } = useI18n();

  // Post-save: stay inside환경 관리. saveDraft already cleared the draft, so the
  // shell drops back to the overview (the env management first page) — we do
  // NOT redirect to home anymore. A toast confirms the save.
  const handleSaved = () => {
    toast.success(t('envManagement.savedToast'));
  };

  return (
    <div className="min-h-screen h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))] flex flex-col overflow-hidden">
      <Suspense fallback={<ShellLoader />}>
        <EnvManagementShell onSaved={handleSaved} />
      </Suspense>
    </div>
  );
}

/**
 * Mounted while `useSearchParams()` is unresolved (prerender pass +
 * the brief client hydration window). Stays minimal — a flicker is
 * acceptable when the alternative is the build failing outright.
 */
function ShellLoader() {
  return (
    <div className="flex-1 flex items-center justify-center text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
      <span className="animate-pulse">환경 관리 로딩 중…</span>
    </div>
  );
}
