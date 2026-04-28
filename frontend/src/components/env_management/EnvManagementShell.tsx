'use client';

/**
 * EnvManagementShell — visual 21-stage environment builder body.
 *
 * Hosted by /app/environments/page.tsx. The page is now header-less;
 * this shell owns the entire chrome (CompactMetaBar at top, then
 * canvas/progress bar/body underneath).
 *
 * Layout:
 *
 *   ┌─ CompactMetaBar (52px) ─────────────────────────────┐
 *   │ ← Home | ✨ Title | name, tags, status, actions     │
 *   ├──────────────────────────────────────────────────────┤
 *   │ Mode A — overview:                                   │
 *   │   PipelineCanvas (or StartFromPicker)                │
 *   │                                                       │
 *   │ Mode B — stage detail (order 0..21):                 │
 *   │   StageProgressBar (scrollable, infinite-wheel)      │
 *   │   ┌──────────────────────────────────────────────┐   │
 *   │   │ order === 0 → GlobalSettingsView              │   │
 *   │   │ order >= 1  → StageDetailView                 │   │
 *   │   └──────────────────────────────────────────────┘   │
 *   └──────────────────────────────────────────────────────┘
 *
 * Stage 0 is a special "globals" entry — it lives in the same body
 * slot as a normal stage but renders the env-wide settings (model /
 * pipeline / tools / externals). The old right-side
 * GlobalSettingsDrawer is gone; the meta bar's "Globals" button just
 * navigates to stage 0.
 */

import { useEffect, useMemo, useState } from 'react';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import CompactMetaBar from './CompactMetaBar';
import OverviewView from './OverviewView';
import StageProgressBar from './StageProgressBar';
import StageDetailView from './StageDetailView';
import GlobalSettingsView from './GlobalSettingsView';

export interface EnvManagementShellProps {
  /** Called after a successful Save with the new env id. The page
   *  wrapper decides where to send the user (back to /, into a
   *  detail drawer, etc.). */
  onSaved?: (newEnvId: string) => void;
}

type ViewMode = { mode: 'overview' } | { mode: 'stage'; order: number };

export default function EnvManagementShell({
  onSaved,
}: EnvManagementShellProps = {}) {
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const isDirty = useEnvironmentDraftStore((s) => s.isDirty);
  const resetDraft = useEnvironmentDraftStore((s) => s.resetDraft);
  const stageDirty = useEnvironmentDraftStore((s) => s.stageDirty);

  const [view, setView] = useState<ViewMode>({ mode: 'overview' });

  // beforeunload guard for browser tab close while dirty
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // If the draft disappears (e.g. after save reset), bail back to
  // overview so we don't render stage view against null data.
  useEffect(() => {
    if (!draft && view.mode === 'stage') {
      setView({ mode: 'overview' });
    }
  }, [draft, view.mode]);

  const activeOrders = useMemo(() => {
    const set = new Set<number>();
    draft?.stages.forEach((s) => {
      if (s.active) set.add(s.order);
    });
    return set;
  }, [draft]);

  const handleSaved = (newEnvId: string) => {
    setView({ mode: 'overview' });
    resetDraft();
    onSaved?.(newEnvId);
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[hsl(var(--background))]">
      <CompactMetaBar
        onSaved={handleSaved}
        onOpenGlobals={() => setView({ mode: 'stage', order: 0 })}
      />

      {view.mode === 'overview' && (
        <OverviewView
          onSelectStage={(order) => setView({ mode: 'stage', order })}
        />
      )}

      {view.mode === 'stage' && draft && (
        <>
          <StageProgressBar
            selectedOrder={view.order}
            onSelect={(order) => setView({ mode: 'stage', order })}
            onBack={() => setView({ mode: 'overview' })}
            dirtyOrders={stageDirty}
            activeOrders={activeOrders}
          />
          {view.order === 0 ? (
            <GlobalSettingsView />
          ) : (
            <StageDetailView order={view.order} />
          )}
        </>
      )}
    </div>
  );
}
