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
import { RefreshCw, Trash2, Power, Zap, Clock, Mail, History } from 'lucide-react';
import { TabShell, ActionButton, EntityCard, EmptyState } from '@/components/common/layout';
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
      <div className="p-4 flex flex-col gap-3">
        {rows.length === 0 ? (
          <EmptyState
            icon={Zap}
            title={t('hooksAutomation.empty')}
            description={t('hooksAutomation.emptyHint')}
          />
        ) : (
          rows.map((h) => (
            <EntityCard
              key={h.name}
              icon={h.kind === 'event' ? <Mail /> : <Clock />}
              iconTone="neutral"
              title={h.description || h.name}
              meta={h.kind}
              status={{ tone: h.status === 'enabled' ? 'good' : 'neutral', label: h.status, as: 'dot' }}
              metaItems={[
                { label: h.cron_expr, mono: true, chip: true },
                ...(h.next_fire_at ? [{ icon: Clock, label: `next ${rel(h.next_fire_at)}` }] : []),
                ...(h.last_fired_at ? [{ icon: History, label: `last ${rel(h.last_fired_at)}` }] : []),
              ]}
              footerActions={
                <>
                  <ActionButton icon={Power} onClick={() => toggle(h)}>
                    {h.status === 'enabled' ? t('hooksAutomation.pause') : t('hooksAutomation.resume')}
                  </ActionButton>
                  <ActionButton variant="danger" icon={Trash2} onClick={() => del(h)}>
                    {t('common.delete')}
                  </ActionButton>
                </>
              }
            >
              {h.action_prompt && <span className="line-clamp-2">{h.action_prompt}</span>}
            </EntityCard>
          ))
        )}
      </div>
    </TabShell>
  );
}

export default HooksAutomationTab;
