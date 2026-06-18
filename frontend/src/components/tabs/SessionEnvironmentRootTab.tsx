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
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import {
  SubTabNav,
  type SubTabDef,
  EmptyState,
} from '@/components/layout';
import { Folder, Layers, Wrench, FolderOpen, Bot, Sparkles } from 'lucide-react';
import { SessionEnvTargetContext } from '@/components/session-env/sessionEnvTarget';
import SubAgentPanel from '@/components/session-env/SubAgentPanel';

const SessionEnvironmentTab = dynamic(
  () => import('@/components/tabs/SessionEnvironmentTab'),
  { ssr: false },
);
const SessionToolsTab = dynamic(() => import('@/components/tabs/SessionToolsTab'));
const WorkspaceTab = dynamic(() => import('@/components/tabs/WorkspaceTab'));

const SUB_TABS: SubTabDef[] = [
  { id: 'manifest', label: 'Manifest', icon: Layers },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
];

const SUB_TAB_COMPONENT: Record<string, React.ComponentType> = {
  manifest: SessionEnvironmentTab,
  tools: SessionToolsTab,
  workspace: WorkspaceTab,
};

export default function SessionEnvironmentRootTab() {
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const subTab = useAppStore((s) => s.sessionEnvSubTab);
  const setSubTab = useAppStore((s) => s.setSessionEnvSubTab);

  const session = sessions.find((s) => s.session_id === sessionId);

  // VTuber ↔ Sub-Worker: a VTuber's linked_session_id points at its paired
  // Sub-Worker. When present, expose a [VTuber / Sub-Agent] toggle so the
  // session-scoped tabs can show (and rebind) either side independently.
  const subWorker = useMemo(() => {
    if (!session || session.role !== 'vtuber' || !session.linked_session_id) {
      return null;
    }
    return (
      sessions.find((s) => s.session_id === session.linked_session_id) ?? null
    );
  }, [session, sessions]);
  const hasSubAgent = !!subWorker;
  // Executor-mode cutover: a VTuber owns a non-session executor sub-agent
  // (no linked_session_id). Surface a Sub-Agent view (read-only panel) for it.
  const isVtuberExecutor = !!session && session.role === 'vtuber' && !subWorker;
  const showAgentToggle = hasSubAgent || isVtuberExecutor;

  // 'vtuber' = the selected session; 'sub' = its linked Sub-Worker.
  const [agentTarget, setAgentTarget] = useState<'vtuber' | 'sub'>('vtuber');
  // Reset to the VTuber side whenever the selected session changes.
  useEffect(() => {
    setAgentTarget('vtuber');
  }, [sessionId]);

  const effectiveSession =
    agentTarget === 'sub' && subWorker ? subWorker : session;
  const effectiveSessionId = effectiveSession?.session_id ?? sessionId ?? null;

  const sessionLabel =
    effectiveSession?.session_name ||
    effectiveSessionId?.slice(0, 12) ||
    '';
  const envId = effectiveSession?.env_id ?? null;

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

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Compact one-line scope bar — session · env, with the agent
          toggle (VTuber/Sub-Agent) right-aligned when paired. No icon,
          no read-only banner (env changes now apply live). */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 h-10 border-b border-[var(--border-color)]">
        <div className="flex items-center gap-1.5 min-w-0 text-[0.75rem]">
          <span className="font-semibold text-[var(--text-primary)] truncate">
            {sessionLabel}
          </span>
          <span className="text-[var(--text-muted)]">·</span>
          {envId ? (
            <code className="font-mono text-[var(--primary-color)] truncate">
              {envId}
            </code>
          ) : (
            <span className="text-[var(--warning-color)]">기본 매니페스트</span>
          )}
        </div>
        {showAgentToggle && (
          <div className="inline-flex rounded-md border border-[var(--border-color)] overflow-hidden shrink-0">
            <AgentToggleButton
              active={agentTarget === 'vtuber'}
              icon={Sparkles}
              label="VTuber"
              onClick={() => setAgentTarget('vtuber')}
            />
            <AgentToggleButton
              active={agentTarget === 'sub'}
              icon={Bot}
              label="Sub-Agent"
              onClick={() => setAgentTarget('sub')}
            />
          </div>
        )}
      </div>
      {agentTarget === 'sub' && isVtuberExecutor ? (
        // Executor sub-agent is not a session — show its read-only panel
        // instead of the env/tools/workspace sub-tabs.
        <div className="flex-1 min-h-0 overflow-hidden">
          <SubAgentPanel vtuberId={sessionId} />
        </div>
      ) : (
        <>
          <SubTabNav tabs={SUB_TABS} active={subTab} onSelect={setSubTab} />
          <div className="flex-1 min-h-0 overflow-hidden">
            <SessionEnvTargetContext.Provider value={effectiveSessionId}>
              <Active />
            </SessionEnvTargetContext.Provider>
          </div>
        </>
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
