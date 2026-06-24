'use client';

/**
 * /sandbox-tool-packs — manager for Sandbox Tool Packs.
 *
 * A pack = an independent GAPT environment (a workspace restorable from a
 * snapshot) + the tools whose code runs inside it + the skills documenting
 * them. Agents author + save packs from chat (env action="save_pack"); this
 * page lets an owner inspect them, gate them (enable/disable — packs are code,
 * so they ship disabled), and delete them. Enable a pack here, then opt an
 * environment into it from the environment editor's Sandbox Tool Packs picker.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Trash2,
  Wrench,
  BookOpen,
  Camera,
} from 'lucide-react';
import {
  sandboxToolPacksApi,
  type SandboxToolPackSummary,
  type SandboxToolPackDetail,
} from '@/lib/api';

export default function SandboxToolPacksPage() {
  const [packs, setPacks] = useState<SandboxToolPackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, SandboxToolPackDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sandboxToolPacksApi.list();
      setPacks(res.packs || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleExpand = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!detail[id]) {
      try {
        const d = await sandboxToolPacksApi.get(id);
        setDetail((prev) => ({ ...prev, [id]: d }));
      } catch (e) {
        toast.error(`Failed to load pack: ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  const onToggleEnabled = async (p: SandboxToolPackSummary) => {
    setBusy(p.id);
    try {
      const updated = await sandboxToolPacksApi.setEnabled(p.id, !p.enabled);
      setPacks((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: updated.enabled } : x)));
      toast.success(`${p.name} ${updated.enabled ? 'enabled' : 'disabled'}`);
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (p: SandboxToolPackSummary) => {
    if (!window.confirm(`Delete pack "${p.name}"? This removes the pack and its snapshot.`)) return;
    setBusy(p.id);
    try {
      await sandboxToolPacksApi.remove(p.id);
      setPacks((prev) => prev.filter((x) => x.id !== p.id));
      toast.success(`Deleted ${p.name}`);
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-[hsl(var(--muted))] flex items-center justify-center shrink-0">
              <Boxes size={20} />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Sandbox Tool Packs</h1>
              <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-0.5 max-w-2xl">
                Each pack bundles a snapshotted sandbox workspace with the tools that
                run inside it and the skills that document them. Enable a pack, then
                opt an environment into it from the environment editor.
              </p>
            </div>
          </div>
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] hover:bg-[hsl(var(--muted))] transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[0.8125rem] text-red-400">
            {error}
          </div>
        )}

        {/* List */}
        {loading && packs.length === 0 ? (
          <div className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] animate-pulse py-12 text-center">
            Loading packs…
          </div>
        ) : packs.length === 0 ? (
          <div className="py-16 text-center border border-dashed border-[hsl(var(--border))] rounded-lg">
            <Boxes size={28} className="mx-auto mb-3 text-[hsl(var(--muted-foreground))]" />
            <p className="text-[0.875rem] font-medium">No packs yet</p>
            <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1">
              An agent creates one from chat: build a tool in its workspace, then
              <code className="mx-1 px-1 rounded bg-[hsl(var(--muted))]">env save_pack</code>.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {packs.map((p) => {
              const isOpen = expanded === p.id;
              const d = detail[p.id];
              return (
                <div
                  key={p.id}
                  className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden"
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button
                      onClick={() => void toggleExpand(p.id)}
                      className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                      aria-label="expand"
                    >
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{p.name}</span>
                        <span className="text-[0.6875rem] px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] inline-flex items-center gap-1">
                          <Wrench size={10} /> {p.tool_count}
                        </span>
                        <span className="text-[0.6875rem] px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] inline-flex items-center gap-1">
                          <BookOpen size={10} /> {p.skill_count}
                        </span>
                      </div>
                      {p.description && (
                        <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] truncate mt-0.5">
                          {p.description}
                        </p>
                      )}
                    </div>
                    {/* enable toggle */}
                    <button
                      onClick={() => void onToggleEnabled(p)}
                      disabled={busy === p.id}
                      title={p.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      className={`relative w-10 h-5 rounded-full transition-colors ${
                        p.enabled ? 'bg-emerald-500' : 'bg-[hsl(var(--muted))]'
                      } disabled:opacity-50`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          p.enabled ? 'translate-x-5' : ''
                        }`}
                      />
                    </button>
                    <button
                      onClick={() => void onDelete(p)}
                      disabled={busy === p.id}
                      className="text-[hsl(var(--muted-foreground))] hover:text-red-400 disabled:opacity-50"
                      title="Delete pack"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 pt-1 border-t border-[hsl(var(--border))] text-[0.8125rem] space-y-3">
                      <div className="flex items-center gap-2 text-[hsl(var(--muted-foreground))] text-[0.75rem]">
                        <Camera size={12} />
                        <span className="font-mono">snapshot {p.snapshot_ref || '—'}</span>
                        <span>·</span>
                        <span className="font-mono">ws {p.workspace_ref || '—'}</span>
                      </div>
                      {!d ? (
                        <div className="text-[hsl(var(--muted-foreground))] animate-pulse">Loading…</div>
                      ) : (
                        <>
                          {d.tools.length > 0 && (
                            <div>
                              <div className="font-medium mb-1 flex items-center gap-1.5">
                                <Wrench size={12} /> Tools
                              </div>
                              <div className="space-y-1">
                                {d.tools.map((t) => (
                                  <div
                                    key={t.name}
                                    className="px-2.5 py-1.5 rounded bg-[hsl(var(--muted))]/50"
                                  >
                                    <span className="font-mono font-medium">{t.name}</span>
                                    <span className="text-[hsl(var(--muted-foreground))]">
                                      {' '}— {t.description || 'no description'}
                                    </span>
                                    <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] font-mono mt-0.5">
                                      {t.runtime} {t.entrypoint}
                                      {t.network_egress ? ' · net' : ''}
                                      {t.read_only ? ' · ro' : ''}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {d.skills.length > 0 && (
                            <div>
                              <div className="font-medium mb-1 flex items-center gap-1.5">
                                <BookOpen size={12} /> Skills
                              </div>
                              <div className="space-y-1">
                                {d.skills.map((s) => (
                                  <div
                                    key={s.id}
                                    className="px-2.5 py-1.5 rounded bg-[hsl(var(--muted))]/50"
                                  >
                                    <span className="font-mono font-medium">{s.id}</span>
                                    <span className="text-[hsl(var(--muted-foreground))]">
                                      {' '}— {s.description || 'no description'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
