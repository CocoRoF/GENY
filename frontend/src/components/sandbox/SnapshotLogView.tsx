'use client';

/**
 * SnapshotLogView — renders a snapshot's "what the agent actually did" log:
 * the chat dialog + tool calls (activity) and the unified file diff. Reused by
 * the pack manager (pack build log) and the Sandbox Logs page. The parent wires
 * the loaders so this component is source-agnostic.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, FileDiff, Wrench, AlertTriangle } from 'lucide-react';
import type {
  SnapshotActivityResponse,
  SnapshotDiffResponse,
} from '@/lib/api';

interface Props {
  loadActivity: () => Promise<SnapshotActivityResponse>;
  loadDiff: () => Promise<SnapshotDiffResponse>;
}

export default function SnapshotLogView({ loadActivity, loadDiff }: Props) {
  const [tab, setTab] = useState<'activity' | 'diff'>('activity');
  const [activity, setActivity] = useState<SnapshotActivityResponse | null>(null);
  const [diff, setDiff] = useState<SnapshotDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, d] = await Promise.allSettled([loadActivity(), loadDiff()]);
      if (a.status === 'fulfilled') setActivity(a.value);
      if (d.status === 'fulfilled') setDiff(d.value);
      if (a.status === 'rejected' && d.status === 'rejected') {
        setError(a.reason instanceof Error ? a.reason.message : String(a.reason));
      }
    } finally {
      setLoading(false);
    }
  }, [loadActivity, loadDiff]);

  useEffect(() => {
    void load();
  }, [load]);

  const turns = activity?.activity?.turns ?? [];
  const cost = activity?.activity?.total_cost_usd;

  return (
    <div className="flex flex-col gap-3">
      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-[hsl(var(--border))]">
        <TabBtn active={tab === 'activity'} onClick={() => setTab('activity')} icon={<MessageSquare size={13} />}>
          활동 (대화·도구) {turns.length ? `· ${turns.length} turn` : ''}
        </TabBtn>
        <TabBtn active={tab === 'diff'} onClick={() => setTab('diff')} icon={<FileDiff size={13} />}>
          변경 (diff)
        </TabBtn>
        {typeof cost === 'number' && cost > 0 && (
          <span className="ml-auto text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            ${cost.toFixed(4)}
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] animate-pulse py-8 text-center">
          로딩 중…
        </div>
      ) : error ? (
        <div className="text-[0.8125rem] text-red-400 py-4">{error}</div>
      ) : tab === 'activity' ? (
        turns.length === 0 ? (
          <div className="py-8 text-center text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
            <AlertTriangle size={20} className="mx-auto mb-2 opacity-60" />
            이 스냅샷에는 기록된 에이전트 활동이 없습니다. (세션에 샌드박스가 붙지
            않았거나, 도구·대화 트레일 없이 저장된 경우)
          </div>
        ) : (
          <div className="space-y-3 max-h-[55vh] overflow-y-auto pr-1">
            {turns.map((t, i) => (
              <div key={i} className="rounded-md border border-[hsl(var(--border))] overflow-hidden">
                {t.user && (
                  <div className="px-3 py-2 bg-[hsl(var(--muted))]/40 text-[0.8125rem]">
                    <span className="text-[0.7rem] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                      user
                    </span>
                    <div className="whitespace-pre-wrap break-words mt-0.5">{t.user}</div>
                  </div>
                )}
                {t.assistant && (
                  <div className="px-3 py-2 text-[0.8125rem] border-t border-[hsl(var(--border))]">
                    <span className="text-[0.7rem] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                      assistant
                    </span>
                    <div className="whitespace-pre-wrap break-words mt-0.5">{t.assistant}</div>
                  </div>
                )}
                {(t.tool_uses ?? []).map((tu, j) => (
                  <div
                    key={j}
                    className="px-3 py-2 text-[0.75rem] border-t border-[hsl(var(--border))] bg-[hsl(var(--background))]"
                  >
                    <div className="flex items-center gap-1.5 font-medium">
                      <Wrench size={11} />
                      <span className="font-mono">{tu.tool}</span>
                      {tu.is_error && (
                        <span className="text-red-400 text-[0.7rem]">error</span>
                      )}
                    </div>
                    {tu.input && (
                      <pre className="mt-1 whitespace-pre-wrap break-words text-[hsl(var(--muted-foreground))] font-mono text-[0.7rem]">
                        → {tu.input}
                      </pre>
                    )}
                    {tu.output && (
                      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[0.7rem]">
                        {tu.output}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="max-h-[55vh] overflow-auto">
          {diff?.unified ? (
            <pre className="text-[0.72rem] font-mono whitespace-pre leading-relaxed">
              {renderDiff(diff.unified)}
            </pre>
          ) : (
            <div className="py-8 text-center text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
              변경 내역이 없습니다.
            </div>
          )}
          {diff?.truncated && (
            <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] mt-2">
              […diff가 잘렸습니다]
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[0.8125rem] border-b-2 -mb-px transition-colors ${
        active
          ? 'border-violet-500 text-[hsl(var(--foreground))]'
          : 'border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// Lightweight diff colorizer: +green / -red / @@hunk.
function renderDiff(unified: string): React.ReactNode {
  return unified.split('\n').map((line, i) => {
    let cls = '';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400';
    else if (line.startsWith('@@')) cls = 'text-violet-400';
    else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-[hsl(var(--muted-foreground))]';
    return (
      <div key={i} className={cls}>
        {line || ' '}
      </div>
    );
  });
}
