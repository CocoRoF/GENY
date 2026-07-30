'use client';

/**
 * /sandboxes — Sandbox Logs. Lists every session sandbox (GAPT workspace) and
 * its snapshots, and shows the ground-truth log per snapshot: the agent's chat
 * dialog + tool calls (activity) and the file diff. This is how you verify what
 * an agent actually did in its sandbox (vs. what it claimed in chat).
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Container,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ScrollText,
  Camera,
  X,
} from 'lucide-react';
import {
  sandboxLogsApi,
  type SandboxSummary,
  type SnapshotSummary,
} from '@/lib/api';
import SnapshotLogView from '@/components/sandbox/SnapshotLogView';
import { IconButton } from '@/components/common/layout';

export default function SandboxLogsPage() {
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [snaps, setSnaps] = useState<Record<string, SnapshotSummary[]>>({});
  const [logSnap, setLogSnap] = useState<SnapshotSummary | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sandboxLogsApi.list();
      setSandboxes(res.sandboxes || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (wid: string) => {
    if (expanded === wid) {
      setExpanded(null);
      return;
    }
    setExpanded(wid);
    if (!snaps[wid]) {
      try {
        const res = await sandboxLogsApi.snapshots(wid);
        setSnaps((prev) => ({ ...prev, [wid]: res.snapshots }));
      } catch (e) {
        toast.error(`스냅샷 로드 실패: ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-[hsl(var(--muted))] flex items-center justify-center shrink-0">
              <ScrollText size={20} />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Sandbox Logs</h1>
              <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-0.5 max-w-2xl">
                세션별 샌드박스(GAPT 워크스페이스)와 스냅샷의 기록입니다. 각 스냅샷의
                로그에서 에이전트가 <b>실제로</b> 한 일(대화·도구 호출·파일 diff)을
                확인할 수 있습니다.
              </p>
            </div>
          </div>
          <IconButton
            icon={RefreshCw}
            title="Refresh"
            spin={loading}
            onClick={() => void refresh()}
          />
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[0.8125rem] text-red-400">
            {error}
          </div>
        )}

        {loading && sandboxes.length === 0 ? (
          <div className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] animate-pulse py-12 text-center">
            로딩 중…
          </div>
        ) : sandboxes.length === 0 ? (
          <div className="py-16 text-center border border-dashed border-[hsl(var(--border))] rounded-lg">
            <Container size={28} className="mx-auto mb-3 text-[hsl(var(--muted-foreground))]" />
            <p className="text-[0.875rem] font-medium">샌드박스가 없습니다</p>
            <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1">
              GAPT 샌드박스가 붙는 세션(예: API키 백엔드)을 실행하면 여기에 나타납니다.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sandboxes.map((s) => {
              const isOpen = expanded === s.id;
              const list = snaps[s.id];
              return (
                <div
                  key={s.id}
                  className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden"
                >
                  <button
                    onClick={() => void toggle(s.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left"
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className="flex-1 min-w-0">
                      <span className="font-medium">{s.name || s.id}</span>
                      <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))] ml-2">
                        {s.status}
                      </span>
                    </span>
                    <span className="text-[0.7rem] px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] inline-flex items-center gap-1">
                      <Camera size={10} /> {s.snapshot_count}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-3 border-t border-[hsl(var(--border))]">
                      {!list ? (
                        <div className="py-3 text-[0.8125rem] text-[hsl(var(--muted-foreground))] animate-pulse">
                          로딩 중…
                        </div>
                      ) : list.length === 0 ? (
                        <div className="py-3 text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
                          스냅샷이 없습니다.
                        </div>
                      ) : (
                        <div className="space-y-1 pt-2">
                          {list.map((snap) => (
                            <div
                              key={snap.id}
                              className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-[hsl(var(--muted))]/40 text-[0.8125rem]"
                            >
                              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-[hsl(var(--background))] font-mono">
                                {snap.kind}
                              </span>
                              <span className="flex-1 min-w-0 truncate">{snap.label || snap.id}</span>
                              <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
                                {snap.summary.turns}t · {snap.summary.tool_calls} tool
                              </span>
                              <button
                                onClick={() => setLogSnap(snap)}
                                className="flex items-center gap-1 text-[0.75rem] px-2 py-0.5 rounded border border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]"
                              >
                                <ScrollText size={11} /> 로그
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {logSnap && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setLogSnap(null)}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
              <div className="flex items-center gap-2 min-w-0">
                <ScrollText size={16} />
                <span className="font-medium truncate">{logSnap.label || logSnap.id} · 로그</span>
              </div>
              <button
                onClick={() => setLogSnap(null)}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto">
              <SnapshotLogView
                loadActivity={() => sandboxLogsApi.snapshot(logSnap.id)}
                loadDiff={() => sandboxLogsApi.diff(logSnap.id)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
