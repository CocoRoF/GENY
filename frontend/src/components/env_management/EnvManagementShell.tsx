'use client';

/**
 * EnvManagementShell — body of the /environments route.
 *
 * Cycle 20260429 — restructured to host five top-level tabs:
 *
 *   ┌─ EnvManagementHeader (44px) ─────────────────────────────────────┐
 *   │ ← Home | [환경관리] [MCP] [SKILLS] [HOOK] [권한]                 │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Tab=environments (default):                                      │
 *   │   CompactMetaBar (52px) — name / tags / actions                  │
 *   │   Body: OverviewView OR StageProgressBar + StageDetailView /     │
 *   │         GlobalSettingsView                                       │
 *   │                                                                  │
 *   │ Tab=mcp / skills / hooks / permissions:                          │
 *   │   Host-level registry editor for that category. The existing     │
 *   │   *Tab components (HooksTab, SkillsTab, PermissionsTab,          │
 *   │   McpServersTab) ship their own TabShell chrome, so nothing else │
 *   │   from this shell competes for vertical space.                   │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Why this layout
 * ---------------
 * The four registry tabs used to be sub-tabs of the main app's
 * "Library" tab — a prototype surface that conflated env CRUD with
 * host-level admin. They now live next to "환경관리" so the
 * operator's mental model is "/environments is the hub for
 * everything that participates in env composition."
 *
 * Stage 0 (the env-side picker for hooks/skills/permissions) only
 * makes sense when an env draft is loaded, so it stays scoped to
 * the `environments` tab. Picking a non-env tab does not touch the
 * draft state — flipping back to `environments` finds the draft
 * exactly as you left it.
 *
 * URL state: `?tab={mcp|skills|hooks|permissions}`. Default
 * (`environments`) drops the param so the canonical URL is
 * `/environments`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import CompactMetaBar from './CompactMetaBar';
import OverviewView from './OverviewView';
import StageProgressBar from './StageProgressBar';
import StageDetailView from './StageDetailView';
import GlobalSettingsView from './GlobalSettingsView';
import EnvManagementHeader, {
  parseTab,
  type EnvManagementTab,
} from './EnvManagementHeader';
import { HooksTab } from '@/components/tabs/HooksTab';
import { SkillsTab } from '@/components/tabs/SkillsTab';
import { PermissionsTab } from '@/components/tabs/PermissionsTab';
import { McpServersTab } from '@/components/tabs/McpServersTab';

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

  const searchParams = useSearchParams();
  const activeTab: EnvManagementTab = parseTab(searchParams.get('tab'));

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
      <EnvManagementHeader active={activeTab} />

      {activeTab === 'environments' && (
        <EnvironmentsTabBody
          view={view}
          setView={setView}
          activeOrders={activeOrders}
          stageDirty={stageDirty}
          draft={draft}
          onSaved={handleSaved}
        />
      )}

      {activeTab === 'mcp' && (
        <RegistryTabSlot>
          <McpServersTab />
        </RegistryTabSlot>
      )}

      {activeTab === 'skills' && (
        <RegistryTabSlot>
          <SkillsTab />
        </RegistryTabSlot>
      )}

      {activeTab === 'hooks' && (
        <RegistryTabSlot>
          <HooksTab />
        </RegistryTabSlot>
      )}

      {activeTab === 'permissions' && (
        <RegistryTabSlot>
          <PermissionsTab />
        </RegistryTabSlot>
      )}
    </div>
  );
}

// ── Sub-bodies ─────────────────────────────────────────────────────

interface EnvironmentsTabBodyProps {
  view: ViewMode;
  setView: (v: ViewMode) => void;
  activeOrders: Set<number>;
  stageDirty: Set<number>;
  draft: ReturnType<typeof useEnvironmentDraftStore.getState>['draft'];
  onSaved: (id: string) => void;
}

function EnvironmentsTabBody({
  view,
  setView,
  activeOrders,
  stageDirty,
  draft,
  onSaved,
}: EnvironmentsTabBodyProps) {
  return (
    <>
      <CompactMetaBar
        onSaved={onSaved}
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
    </>
  );
}

/**
 * RegistryTabSlot — thin wrapper that lets the host registry tabs
 * own their full TabShell chrome (header + body + actions). The
 * registry tabs already render their own scrolling shell, so we
 * just give them the remaining vertical space.
 */
function RegistryTabSlot({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 min-h-0 flex flex-col">{children}</div>;
}
