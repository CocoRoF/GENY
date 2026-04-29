'use client';

/**
 * EnvManagementShell — body of the /environments route.
 *
 * Cycle 20260429 hub-and-spoke restructure:
 *
 *   ┌─ FIRST SCREEN (hub) ─────────────────────────────────────────────┐
 *   │ EnvManagementHeader (44px)                                       │
 *   │   ← Home | [환경관리 ★] [MCP] [SKILLS] [HOOK] [권한]             │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ OverviewView — env list + "새 드래프트" welcome card             │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ ENV EDIT (after "새 드래프트") ─────────────────────────────────┐
 *   │ CompactMetaBar (52px) — owns its own ← 홈으로 + name/tags/save   │
 *   │ Body: StageProgressBar + StageDetailView / GlobalSettingsView    │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ HOST REGISTRY TAB (?tab=mcp / skills / hooks / permissions) ───┐
 *   │ EnteredSectionBackBar — slim ← 환경 hub link (24px)              │
 *   │ <Registry tab body with its own TabShell chrome>                 │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Why hub-and-spoke
 * -----------------
 * The previous always-visible 5-tab strip stacked on top of
 * CompactMetaBar produced a double-header — two competing rows of
 * chrome before any actual content. The operator complained: when
 * I'm editing a draft I do not need to see the navigation strip.
 *
 * Now the strip is the FIRST-SCREEN navigation only. Once the
 * operator picks an area (clicks a tab OR clicks "새 드래프트"),
 * the strip steps aside. Each section provides its own ← back
 * navigation:
 *
 *   - env edit  → CompactMetaBar's ← 홈으로 (re-introduced)
 *   - host tabs → EnteredSectionBackBar above the registry chrome
 *
 * "First screen" precisely means: `tab === 'environments'` AND
 * draft is null AND view is overview. Any other state is a
 * "section" view and hides the strip.
 *
 * URL state stays the same (`?tab=...`). Switching tabs is still
 * possible — click ← back to return to the hub, then pick another.
 * Draft state is preserved through the Zustand store while the
 * operator detours, so coming back to the env tab finds the draft
 * exactly as it was.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Layers, Network, Plug, Shield, Sparkles } from 'lucide-react';
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
  /** Called after a successful Save with the new env id. */
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

  // ── Hub-vs-section decision ─────────────────────────────────────
  // First screen = env overview, no draft. Anything else is a
  // "section" view and hides the 5-tab strip.
  const isFirstScreen =
    activeTab === 'environments' && !draft && view.mode === 'overview';

  return (
    <div className="flex flex-col h-full min-h-0 bg-[hsl(var(--background))]">
      {isFirstScreen && <EnvManagementHeader active="environments" />}

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
        <SectionFrame label="MCP" icon={Network}>
          <McpServersTab />
        </SectionFrame>
      )}

      {activeTab === 'skills' && (
        <SectionFrame label="SKILLS" icon={Sparkles}>
          <SkillsTab />
        </SectionFrame>
      )}

      {activeTab === 'hooks' && (
        <SectionFrame label="HOOK" icon={Plug}>
          <HooksTab />
        </SectionFrame>
      )}

      {activeTab === 'permissions' && (
        <SectionFrame label="권한" icon={Shield}>
          <PermissionsTab />
        </SectionFrame>
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
 * SectionFrame — wraps a host registry tab with a slim back bar.
 * Replaces the previous EnvManagementHeader stack so each entered
 * section gets its own minimal chrome instead of competing with
 * the 5-tab strip.
 *
 * Back link goes to `/environments` (hub) — clearing the `?tab=`
 * param brings the operator back to the first screen where they
 * can pick a different area.
 */
function SectionFrame({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-3 px-3 h-9 shrink-0 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <Link
          href="/environments"
          className="inline-flex items-center gap-1 h-7 px-2 rounded text-[0.75rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] no-underline transition-colors hover:bg-[hsl(var(--accent))]"
        >
          <ArrowLeft size={13} />
          환경 관리
        </Link>
        <div className="w-px h-4 bg-[hsl(var(--border))]" />
        <div className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </>
  );
}
