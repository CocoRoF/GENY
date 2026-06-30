'use client';

/**
 * SessionEnvironmentRootTab — *session-bound* Environment view.
 *
 * Scope: requires a selected session. Operates strictly on what's
 * loaded into THAT session (manifest of bound env, currently-loaded
 * tools, workspace stack). System-wide editing happens in the global
 * EnvironmentTab ("Library") — sister surface.
 *
 * Sub-tabs (all session-scoped):
 *   manifest   → SessionEnvironmentTab — stage tree of bound env
 *   tools      → SessionToolsTab — tools actually loaded
 *   workspace  → WorkspaceTab — WorkspaceStack snapshot + cleanup
 *
 * Hard guard: renders an explicit empty state when no session is
 * selected. Direct deeplinks to this tab without a session won't
 * silently render half-broken sub-tabs.
 */

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import {
  SubTabNav,
  type SubTabDef,
  EmptyState,
} from '@/components/common/layout';
import { Folder, Bot, User } from 'lucide-react';
import { SectionIcons } from '@/components/common/icons';
import { useI18n } from '@/lib/i18n';
import { SessionEnvTargetContext } from '@/components/session-env/sessionEnvTarget';
import SubAgentPanel from '@/components/session-env/SubAgentPanel';

const SessionEnvironmentTab = dynamic(
  () => import('@/components/tabs/SessionEnvironmentTab'),
  { ssr: false },
);
const SessionToolsTab = dynamic(() => import('@/components/tabs/SessionToolsTab'));
const WorkspaceTab = dynamic(() => import('@/components/tabs/WorkspaceTab'));

const SUB_TABS: SubTabDef[] = [
  { id: 'manifest', label: 'Manifest', icon: SectionIcons.manifest },
  { id: 'tools', label: 'Tools', icon: SectionIcons.tools },
  { id: 'workspace', label: 'Workspace', icon: SectionIcons.workspace },
];

const SUB_TAB_COMPONENT: Record<string, React.ComponentType> = {
  manifest: SessionEnvironmentTab,
  tools: SessionToolsTab,
  workspace: WorkspaceTab,
};

export default function SessionEnvironmentRootTab() {
  const { t } = useI18n();
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const subTab = useAppStore((s) => s.sessionEnvSubTab);
  const setSubTab = useAppStore((s) => s.setSessionEnvSubTab);

  const session = sessions.find((s) => s.session_id === sessionId);

  // Agent / Sub-Agent: an agent OWNS a persistent companion sub-agent when its
  // env declares one (host_selections.extras.owned_subagent) — surfaced here as
  // ``executor_sub_agent_id``. This is env-driven, NOT role-driven: any agent
  // may own one. When present, expose an [Agent / Sub-Agent] toggle — "Agent" =
  // this session's env (manifest/tools/workspace), "Sub-Agent" = the read-only
  // companion panel (the companion inherits this env, so it has nothing
  // separate to configure).
  const ownsSubAgent = !!session?.executor_sub_agent_id;

  const [agentTarget, setAgentTarget] = useState<'agent' | 'sub'>('agent');
  // Reset to the Agent side whenever the selected session changes.
  useEffect(() => {
    setAgentTarget('agent');
  }, [sessionId]);

  const effectiveSessionId = sessionId ?? null;
  const sessionLabel =
    session?.session_name || effectiveSessionId?.slice(0, 12) || '';

  // Hard guard: never render session-scoped sub-tabs without a session.
  if (!sessionId || !session) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="shrink-0 px-4 py-2 border-b border-[var(--border-color)] bg-[rgba(245,158,11,0.06)] flex items-center gap-2">
          <Folder size={14} className="text-[var(--warning-color)]" />
          <span className="text-[0.8125rem] font-semibold text-[var(--text-primary)]">
            Environment
          </span>
          <span className="text-[0.6875rem] text-[var(--text-muted)]">
            · session-scoped
          </span>
        </div>
        <EmptyState
          icon={Folder}
          title="No session selected"
          description="The session-scoped Environment view shows the manifest, loaded tools, and workspace stack of a single session. Pick one from the sidebar."
        />
      </div>
    );
  }

  const Active = SUB_TAB_COMPONENT[subTab] ?? SessionEnvironmentTab;
  const showSubAgent = agentTarget === 'sub' && ownsSubAgent;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Single-line bar: agent name (identity) + the sub-tabs, same family as
          every other tab strip (SubTabNav). The Agent/Sub-Agent toggle, when
          this session owns a companion, is pinned right. Tabs hide on the
          Sub-Agent side (its panel is a single read-only view). */}
      <SubTabNav
        className="h-[49px]"
        tabs={showSubAgent ? [] : SUB_TABS}
        active={subTab}
        onSelect={setSubTab}
        leading={
          <span
            className="text-xs font-semibold text-[hsl(var(--foreground))] truncate max-w-[180px]"
            title={sessionLabel}
          >
            {sessionLabel}
          </span>
        }
        trailing={
          ownsSubAgent ? (
            <div className="inline-flex rounded-md border border-[var(--border-color)] overflow-hidden shrink-0">
              <AgentToggleButton
                active={agentTarget === 'agent'}
                icon={User}
                label={t('sessionEnvironmentTab.agentToggle.agent')}
                onClick={() => setAgentTarget('agent')}
              />
              <AgentToggleButton
                active={agentTarget === 'sub'}
                icon={Bot}
                label={t('sessionEnvironmentTab.agentToggle.subAgent')}
                onClick={() => setAgentTarget('sub')}
              />
            </div>
          ) : undefined
        }
      />
      {showSubAgent ? (
        // The owned companion is not a session — show its read-only panel
        // instead of the env/tools/workspace sub-tabs.
        <div className="flex-1 min-h-0 overflow-hidden">
          <SubAgentPanel ownerId={sessionId} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden">
          <SessionEnvTargetContext.Provider value={effectiveSessionId}>
            <Active />
          </SessionEnvTargetContext.Provider>
        </div>
      )}
    </div>
  );
}

function AgentToggleButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof Bot;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1 text-[0.6875rem] font-semibold transition-colors cursor-pointer"
      style={{
        background: active ? 'var(--primary-color)' : 'transparent',
        color: active ? '#ffffff' : 'var(--text-secondary)',
      }}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}
