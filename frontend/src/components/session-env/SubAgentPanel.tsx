'use client';

/**
 * SubAgentPanel — read-only view of the persistent companion sub-agent an
 * agent owns (env-driven via host_selections.extras.owned_subagent). The
 * sub-agent is not a session, so it has no sidebar entry; this panel surfaces
 * its status, recent conversation, and pending completion notifications via
 * GET /api/agents/{ownerId}/sub-agent.
 */

import { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, Inbox } from 'lucide-react';
import { agentApi } from '@/lib/api';

interface SubAgentView {
  sub_agent_id: string;
  agent_type?: string;
  status: string;
  conversation: Array<{ role: string; content: string }>;
  inbox_count: number;
}

export default function SubAgentPanel({ ownerId }: { ownerId: string }) {
  const [data, setData] = useState<SubAgentView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await agentApi.getSubAgent(ownerId);
      setData(res as SubAgentView);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'no sub-agent');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text-muted)]">
        <Bot size={28} className="opacity-50" />
        <p className="text-[0.8125rem]">이 에이전트가 소유한 sub-agent가 없습니다.</p>
        <p className="text-[0.6875rem] opacity-70">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="shrink-0 px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] flex items-center gap-2 flex-wrap">
        <Bot size={14} className="text-[var(--primary-color)]" />
        <span className="text-[0.8125rem] font-semibold text-[var(--text-primary)]">
          Sub-Agent
        </span>
        {data && (
          <>
            <code className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]">
              {data.sub_agent_id}
            </code>
            <span
              className="text-[0.625rem] px-1.5 py-0.5 rounded font-semibold"
              style={{
                background:
                  data.status === 'running'
                    ? 'rgba(34,197,94,0.15)'
                    : 'rgba(107,114,128,0.15)',
                color:
                  data.status === 'running'
                    ? 'var(--success-color)'
                    : 'var(--text-muted)',
              }}
            >
              {data.status}
            </span>
            {data.inbox_count > 0 && (
              <span className="inline-flex items-center gap-1 text-[0.625rem] text-[var(--warning-color)]">
                <Inbox size={11} />
                {data.inbox_count}
              </span>
            )}
          </>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto inline-flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          aria-label="refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-2">
        {!data || data.conversation.length === 0 ? (
          <p className="text-[0.75rem] text-[var(--text-muted)] text-center mt-8">
            아직 대화 내역이 없습니다. 에이전트가 작업을 위임하면 여기에 표시됩니다.
          </p>
        ) : (
          data.conversation.map((m, i) => (
            <div
              key={i}
              className="rounded-md border border-[var(--border-color)] p-2.5 bg-[var(--bg-primary)]"
            >
              <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">
                {m.role}
              </div>
              <div className="text-[0.75rem] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                {m.content}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
