'use client';

/**
 * EnvManagementShell — body of the /environments route.
 *
 * Cycle 20260429 follow-up — single-row chrome via dropdown
 * navigation. The previous design had two competing chrome rows
 * (5-tab strip + CompactMetaBar). The operator's call: ONE row
 * always, with a dropdown switcher in place of the tab strip.
 *
 * Layout:
 *
 *   ┌─ CompactMetaBar (52px, ALWAYS) ─────────────────────────────┐
 *   │ [← 홈] [Tab Dropdown ▼]  [name] [tags] ...  [actions]       │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Body (depends on tab + draft):                              │
 *   │   tab=environments + no draft → OverviewView welcome        │
 *   │   tab=environments + draft    → canvas / stage editor       │
 *   │   tab=mcp/skills/hooks/perms  → registry tab (TabShell)     │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * The tab dropdown lives in CompactMetaBar's leading edge —
 * clicking it pops a 5-option panel below (animated bounce). Pick
 * one → URL updates → body switches. The trigger always shows the
 * current tab name, so the operator's "where am I" is one glance
 * away regardless of state.
 *
 * env-edit fields (name / tags / actions) inside CompactMetaBar
 * gate on `(activeTab === 'environments' && draft)`. Other states
 * keep the row minimal — just the nav cluster.
 *
 * URL state: `?tab=...`. Default tab (`environments`) drops the
 * param so the canonical URL stays `/environments`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import CompactMetaBar from './CompactMetaBar';
import OverviewView from './OverviewView';
import StageProgressBar from './StageProgressBar';
import StageDetailView from './StageDetailView';
import GlobalSettingsView from './GlobalSettingsView';
import {
  parseTab,
  type EnvManagementTab,
} from './EnvManagementHeader';
import { HooksTab } from '@/components/tabs/HooksTab';
import { SkillsTab } from '@/components/tabs/SkillsTab';
import { PermissionsTab } from '@/components/tabs/PermissionsTab';
import { McpServersTab } from '@/components/tabs/McpServersTab';
import { TriggersTab } from '@/components/tabs/TriggersTab';
import { CustomToolsTab } from '@/components/tabs/CustomToolsTab';
import SandboxToolPacksManager from '@/components/sandbox_tool_packs/SandboxToolPacksManager';

export interface EnvManagementShellProps {
  /** Called after a successful Save with the new env id. */
  onSaved?: (newEnvId: string) => void;
}

type ViewMode = { mode: 'overview' } | { mode: 'stage'; order: number };

export default function EnvManagementShell({
  onSaved,
}: EnvManagementShellProps = {}) {
  const { t } = useI18n();
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const isDirty = useEnvironmentDraftStore((s) => s.isDirty);
  const resetDraft = useEnvironmentDraftStore((s) => s.resetDraft);
  const stageDirty = useEnvironmentDraftStore((s) => s.stageDirty);

  const searchParams = useSearchParams();
  const activeTab: EnvManagementTab = parseTab(searchParams.get('tab'));

  const [view, setView] = useState<ViewMode>({ mode: 'overview' });

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

  // Back button while editing → return to the env-management overview (drop the
  // draft) instead of leaving /environments. We arm a history sentinel when the
  // editor OPENS; the Back press pops it and we reset to the overview, with a
  // dirty-confirm so unsaved edits aren't lost silently.
  //
  // Depend ONLY on whether a draft exists (`editing`), NOT the draft object —
  // otherwise every keystroke/stage edit re-runs this effect and pushes a new
  // history entry, flooding the back stack. isDirty/resetDraft are read from
  // the store at call time so they don't need to be deps.
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    window.history.pushState({ envEditor: true }, '');
    const onPopState = () => {
      const st = useEnvironmentDraftStore.getState();
      if (st.isDirty() && !confirm(t('envManagement.confirmDiscard'))) {
        // Cancelled — re-arm so the editor stays put.
        window.history.pushState({ envEditor: true }, '');
        return;
      }
      st.resetDraft();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

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

  // Stages whose ``model_override`` toggle is ON — i.e. stages that
  // pin their own ModelConfig instead of inheriting the pipeline
  // model. The s06_api and s18_memory editors are the common ones
  // but ``StageGenericEditor`` lets any stage opt in, so we scan
  // the whole draft. Surfaced as a "Model" badge in the stage
  // progress bar + pipeline canvas — operators see at a glance
  // which stages diverge from the global model.
  const modelOrders = useMemo(() => {
    const set = new Set<number>();
    draft?.stages.forEach((s) => {
      if (s.model_override != null) set.add(s.order);
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
      {/* Single-row chrome — always rendered. The bar's content
          adapts: env-edit fields appear only when on the env tab
          with a loaded draft. */}
      <CompactMetaBar
        activeTab={activeTab}
        onSaved={handleSaved}
        onOpenGlobals={() => setView({ mode: 'stage', order: 0 })}
      />

      {activeTab === 'environments' && (
        <>
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
                modelOrders={modelOrders}
              />
              {view.order === 0 ? (
                <GlobalSettingsView />
              ) : (
                <StageDetailView order={view.order} />
              )}
            </>
          )}
        </>
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

      {activeTab === 'custom_tools' && (
        <RegistryTabSlot>
          <CustomToolsTab />
        </RegistryTabSlot>
      )}

      {activeTab === 'sandbox_packs' && (
        <RegistryTabSlot>
          <SandboxToolPacksManager embedded />
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

      {activeTab === 'triggers' && (
        <RegistryTabSlot>
          <TriggersTab />
        </RegistryTabSlot>
      )}
    </div>
  );
}

/**
 * RegistryTabSlot — gives the host registry tabs the remaining
 * vertical space. They ship their own TabShell chrome so the
 * shell doesn't add anything else.
 */
function RegistryTabSlot({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 min-h-0 flex flex-col">{children}</div>;
}
