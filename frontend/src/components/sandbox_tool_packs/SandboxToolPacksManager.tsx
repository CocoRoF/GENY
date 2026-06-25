'use client';

/**
 * SandboxToolPacksManager — the reusable Sandbox Tool Packs manager.
 *
 * A pack = an independent GAPT environment (workspace restorable from a snapshot)
 * + the tools whose code runs inside it + the skills documenting them. It's a
 * first-class **Agent Environment component**, so this renders BOTH as a standalone
 * page (/sandbox-tool-packs) and as the "Sandbox Tool Packs" section of the
 * environment editor (?tab=sandbox_packs) via the `embedded` prop. Fully localized
 * (sandboxPacks.* i18n) and surfaces the pack's sandbox/runtime info.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Boxes, ChevronDown, ChevronRight, RefreshCw, Trash2, Wrench, BookOpen,
  Camera, ScrollText, X, FolderGit2, TerminalSquare, Globe, Lock, Clock,
} from 'lucide-react';
import {
  sandboxToolPacksApi,
  type SandboxToolPackSummary,
  type SandboxToolPackDetail,
} from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import SnapshotLogView from '@/components/sandbox/SnapshotLogView';

function Ref({ icon: Icon, label, value }: { icon: any; label: string; value?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
      <Icon size={11} /> {label} <span className="font-mono text-[hsl(var(--foreground))]">{value || '—'}</span>
    </span>
  );
}

export default function SandboxToolPacksManager({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [packs, setPacks] = useState<SandboxToolPackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, SandboxToolPackDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [logPack, setLogPack] = useState<SandboxToolPackSummary | null>(null);

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

  useEffect(() => { void refresh(); }, [refresh]);

  const toggleExpand = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!detail[id]) {
      try {
        const d = await sandboxToolPacksApi.get(id);
        setDetail((prev) => ({ ...prev, [id]: d }));
      } catch (e) {
        toast.error(t('sandboxPacks.loadFailed', { error: e instanceof Error ? e.message : String(e) }));
      }
    }
  };

  const onToggleEnabled = async (p: SandboxToolPackSummary) => {
    setBusy(p.id);
    try {
      const updated = await sandboxToolPacksApi.setEnabled(p.id, !p.enabled);
      setPacks((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: updated.enabled } : x)));
      toast.success(`${p.name} — ${updated.enabled ? t('sandboxPacks.enabled') : t('sandboxPacks.disabled')}`);
    } catch (e) {
      toast.error(t('sandboxPacks.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (p: SandboxToolPackSummary) => {
    if (!window.confirm(t('sandboxPacks.deleteConfirm', { name: p.name }))) return;
    setBusy(p.id);
    try {
      await sandboxToolPacksApi.remove(p.id);
      setPacks((prev) => prev.filter((x) => x.id !== p.id));
      toast.success(t('sandboxPacks.deleted', { name: p.name }));
    } catch (e) {
      toast.error(t('sandboxPacks.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const body = (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-[hsl(var(--muted))] flex items-center justify-center shrink-0">
            <Boxes size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t('sandboxPacks.title')}</h1>
            <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-0.5 max-w-2xl">
              {t('sandboxPacks.subtitle')}
            </p>
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] hover:bg-[hsl(var(--muted))] transition-colors shrink-0"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          {t('sandboxPacks.refresh')}
        </button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[0.8125rem] text-red-400">
          {error}
        </div>
      )}

      {loading && packs.length === 0 ? (
        <div className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] animate-pulse py-12 text-center">
          {t('sandboxPacks.loading')}
        </div>
      ) : packs.length === 0 ? (
        <div className="py-16 text-center border border-dashed border-[hsl(var(--border))] rounded-lg">
          <Boxes size={28} className="mx-auto mb-3 text-[hsl(var(--muted-foreground))]" />
          <p className="text-[0.875rem] font-medium">{t('sandboxPacks.empty.title')}</p>
          <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] mt-1 max-w-md mx-auto">
            {t('sandboxPacks.empty.desc')}
          </p>
          <p className="text-[0.75rem] text-amber-400/90 mt-3 max-w-md mx-auto">{t('sandboxPacks.empty.warn')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {packs.map((p) => {
            const isOpen = expanded === p.id;
            const d = detail[p.id];
            return (
              <div key={p.id} className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => void toggleExpand(p.id)} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]" aria-label="expand">
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
                      <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] truncate mt-0.5">{p.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => void onToggleEnabled(p)}
                    disabled={busy === p.id}
                    title={p.enabled ? t('sandboxPacks.disableHint') : t('sandboxPacks.enableHint')}
                    className={`relative w-10 h-5 rounded-full transition-colors ${p.enabled ? 'bg-emerald-500' : 'bg-[hsl(var(--muted))]'} disabled:opacity-50`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${p.enabled ? 'translate-x-5' : ''}`} />
                  </button>
                  <button onClick={() => setLogPack(p)} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]" title={t('sandboxPacks.buildLog')}>
                    <ScrollText size={15} />
                  </button>
                  <button onClick={() => void onDelete(p)} disabled={busy === p.id} className="text-[hsl(var(--muted-foreground))] hover:text-red-400 disabled:opacity-50" title={t('sandboxPacks.delete')}>
                    <Trash2 size={15} />
                  </button>
                </div>

                {isOpen && (
                  <div className="px-4 pb-4 pt-1 border-t border-[hsl(var(--border))] text-[0.8125rem] space-y-3">
                    {/* Sandbox environment identity */}
                    <div>
                      <div className="font-medium mb-1.5 flex items-center gap-1.5"><Camera size={12} /> {t('sandboxPacks.environment')}</div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2.5 py-2 rounded bg-[hsl(var(--muted))]/50">
                        <Ref icon={FolderGit2} label={t('sandboxPacks.project')} value={p.project_ref} />
                        <Ref icon={Boxes} label={t('sandboxPacks.workspace')} value={p.workspace_ref} />
                        <Ref icon={Camera} label={t('sandboxPacks.snapshot')} value={p.snapshot_ref} />
                      </div>
                    </div>

                    {!d ? (
                      <div className="text-[hsl(var(--muted-foreground))] animate-pulse">{t('sandboxPacks.loading')}</div>
                    ) : (
                      <>
                        {d.tools.length > 0 && (
                          <div>
                            <div className="font-medium mb-1 flex items-center gap-1.5"><Wrench size={12} /> {t('sandboxPacks.tools')}</div>
                            <div className="space-y-1.5">
                              {d.tools.map((tool) => (
                                <div key={tool.name} className="px-2.5 py-2 rounded bg-[hsl(var(--muted))]/50">
                                  <div>
                                    <span className="font-mono font-medium">{tool.name}</span>
                                    <span className="text-[hsl(var(--muted-foreground))]"> — {tool.description || t('sandboxPacks.noDescription')}</span>
                                  </div>
                                  {/* sandbox runtime / env info */}
                                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                                    <span className="inline-flex items-center gap-1"><TerminalSquare size={11} /> {tool.runtime} <span className="font-mono">{tool.entrypoint}</span></span>
                                    <span className="inline-flex items-center gap-1"><FolderGit2 size={11} /> {tool.workdir}</span>
                                    <span className="inline-flex items-center gap-1"><Clock size={11} /> {tool.timeout_s}s</span>
                                    <span className={`inline-flex items-center gap-1 ${tool.network_egress ? 'text-amber-400' : ''}`}><Globe size={11} /> {tool.network_egress ? t('sandboxPacks.egressOn') : t('sandboxPacks.egressOff')}</span>
                                    {tool.read_only && <span className="inline-flex items-center gap-1"><Lock size={11} /> {t('sandboxPacks.readOnly')}</span>}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {d.skills.length > 0 && (
                          <div>
                            <div className="font-medium mb-1 flex items-center gap-1.5"><BookOpen size={12} /> {t('sandboxPacks.skills')}</div>
                            <div className="space-y-1">
                              {d.skills.map((s) => (
                                <div key={s.id} className="px-2.5 py-1.5 rounded bg-[hsl(var(--muted))]/50">
                                  <span className="font-mono font-medium">{s.id}</span>
                                  <span className="text-[hsl(var(--muted-foreground))]"> — {s.description || t('sandboxPacks.noDescription')}</span>
                                  {s.allowed_tools?.length > 0 && (
                                    <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] font-mono mt-0.5">→ {s.allowed_tools.join(', ')}</div>
                                  )}
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
    </>
  );

  return (
    <div className={embedded
      ? 'flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5'
      : 'min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))]'}>
      <div className={embedded ? 'max-w-4xl mx-auto' : 'max-w-4xl mx-auto px-6 py-8'}>{body}</div>

      {/* Build-log modal */}
      {logPack && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setLogPack(null)}>
          <div className="w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
              <div className="flex items-center gap-2 min-w-0">
                <ScrollText size={16} />
                <span className="font-medium truncate">{logPack.name} · {t('sandboxPacks.buildLogTitle')}</span>
              </div>
              <button onClick={() => setLogPack(null)} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"><X size={16} /></button>
            </div>
            <div className="p-4 overflow-y-auto">
              <SnapshotLogView loadActivity={() => sandboxToolPacksApi.activity(logPack.id)} loadDiff={() => sandboxToolPacksApi.diff(logPack.id)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
