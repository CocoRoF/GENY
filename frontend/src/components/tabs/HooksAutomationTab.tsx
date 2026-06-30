'use client';

/**
 * HooksAutomationTab — the "Hooks" session tab.
 *
 * Lists the background automations ("Hooks") the agent created in THIS session
 * (via the HookCreate tool when the user asked in chat), and lets the user
 * pause/resume or delete them. There is no create form — hooks are made
 * conversationally ("매일 아침 9시에 …", "… 메일 오면 알려줘"). Backed by
 * /api/automations (cron jobs with target_kind=agent_hook).
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/useAppStore';
import { hooksApi, HookRecord } from '@/lib/api';
import { RefreshCw, Trash2, Power, Zap, Clock, Mail } from 'lucide-react';
import { TabShell, ActionButton, StatusBadge, DataTable, EmptyState } from '@/components/layout';
import { useI18n } from '@/lib/i18n';

const POLL_MS = 30_000;

function rel(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const sec = Math.round(abs / 1000);
    const fmt = sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86400 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86400)}d`;
    return diff >= 0 ? `in ${fmt}` : `${fmt} ago`;
  } catch {
    return iso;
  }
}

export function HooksAutomationTab() {
  const sessionId = useAppStore((s) => s.selectedSessionId) || '';
  const { t } = useI18n();
  const [rows, setRows] = useState<HookRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await hooksApi.list(sessionId || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const toggle = async (h: HookRecord) => {
    try {
      await hooksApi.setStatus(h.name, h.status === 'enabled' ? 'disabled' : 'enabled');
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const del = async (h: HookRecord) => {
    if (!window.confirm(t('hooksAutomation.confirmDelete', { name: h.description || h.name }))) return;
    try {
      await hooksApi.delete(h.name);
      toast.success(t('hooksAutomation.deleted'));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <TabShell
      title={t('tabs.hooks')}
      icon={Zap}
      error={error}
      onDismissError={() => setError(null)}
      loading={loading}
      bodyScroll="auto"
      actions={
        <ActionButton icon={RefreshCw} spinIcon={loading} onClick={refresh} disabled={loading}>
          {t('common.refresh')}
        </ActionButton>
      }
    >
      <DataTable
        rows={rows}
        keyOf={(h) => h.name}
        loading={loading}
        expandable
        empty={
          <EmptyState
            icon={Zap}
            title={t('hooksAutomation.empty')}
            description={t('hooksAutomation.emptyHint')}
          />
        }
        renderRow={(h) => (
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-[var(--text-muted)] shrink-0">
              {h.kind === 'event' ? <Mail size={15} /> : <Clock size={15} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm truncate text-[hsl(var(--foreground))]">
                  {h.description || h.name}
                </span>
                <StatusBadge tone={h.status === 'enabled' ? 'success' : 'neutral'}>{h.status}</StatusBadge>
                <StatusBadge tone="info">{h.kind}</StatusBadge>
              </div>
              {h.action_prompt && (
                <p className="text-[0.8125rem] text-[var(--text-secondary)] mt-1 line-clamp-1">{h.action_prompt}</p>
              )}
              <div className="text-[0.6875rem] text-[var(--text-muted)] mt-1 flex gap-3 flex-wrap font-mono">
                <span>{h.cron_expr}</span>
                {h.next_fire_at && <span>next {rel(h.next_fire_at)}</span>}
                {h.last_fired_at && <span>last {rel(h.last_fired_at)}</span>}
              </div>
            </div>
          </div>
        )}
        renderExpanded={(h) => (
          <div className="text-[0.8125rem] text-[var(--text-secondary)] space-y-2">
            {h.action_prompt && (
              <div>
                <div className="text-[0.6875rem] uppercase tracking-wider text-[var(--text-muted)] mb-1">Action</div>
                <p className="whitespace-pre-wrap break-words">{h.action_prompt}</p>
              </div>
            )}
            <div className="flex gap-4 flex-wrap text-[0.6875rem] font-mono text-[var(--text-muted)]">
              <span>cron: {h.cron_expr}</span>
              <span>kind: {h.kind}</span>
              {h.next_fire_at && <span>next: {rel(h.next_fire_at)}</span>}
              {h.last_fired_at && <span>last: {rel(h.last_fired_at)}</span>}
            </div>
          </div>
        )}
        rowActions={(h) => [
          {
            icon: Power,
            label: h.status === 'enabled' ? t('hooksAutomation.pause') : t('hooksAutomation.resume'),
            onClick: () => toggle(h),
          },
          { icon: Trash2, label: t('common.delete'), danger: true, onClick: () => del(h) },
        ]}
      />
    </TabShell>
  );
}

export default HooksAutomationTab;
