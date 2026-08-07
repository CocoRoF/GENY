// 히스토리 — who changed what in this storage, newest first.
//
// The sync journal already records WHAT changed; it cannot say WHO. That is
// the only interesting question when a file you did not touch changes
// underneath you — was it your laptop catching up, an agent working, or you
// on another tab? So every mutation is attributed at the moment it happens
// (the actor is known only there) and read back here.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, Cloud, FilePlus2, FileX2, FolderPlus, History, Monitor, MoveRight, Pencil, Upload, User } from 'lucide-react';
import { agentApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { DataTable, EmptyState, StatusBadge, type BadgeTone } from '@/components/common/layout';

export interface SyncEvent {
  id: number;
  ts: number;
  actor_kind: 'device' | 'web' | 'agent' | string;
  actor: string;
  action: string;
  path: string;
  size: number;
  detail: string;
}

const ACTION_TONE: Record<string, BadgeTone> = {
  added: 'success',
  uploaded: 'success',
  mkdir: 'success',
  updated: 'info',
  renamed: 'warning',
  deleted: 'danger',
};

const ACTION_ICON: Record<string, typeof FilePlus2> = {
  added: FilePlus2,
  uploaded: Upload,
  mkdir: FolderPlus,
  updated: Pencil,
  renamed: MoveRight,
  deleted: FileX2,
};

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

function formatWhen(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export default function CloudHistoryView({ scopeId }: { scopeId: string }) {
  const { t } = useI18n();
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async (before = 0) => {
    try {
      const r = await agentApi.storageHistory(scopeId, 200, before);
      setEvents((prev) => (before ? [...prev, ...(r.events || [])] : r.events || []));
      setHasMore(!!r.has_more);
    } catch {
      if (!before) setEvents([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => {
    setLoading(true);
    void load(0);
    // The history is a live feed of a live folder: an agent writing right
    // now should appear without the user hunting for a refresh button.
    const timer = setInterval(() => void load(0), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const actorCell = (e: SyncEvent): React.ReactNode => {
    const Icon = e.actor_kind === 'device' ? Monitor : e.actor_kind === 'agent' ? Bot : User;
    const color =
      e.actor_kind === 'device' ? 'text-[#4f9cf7]'
      : e.actor_kind === 'agent' ? 'text-[#2fbf71]'
      : 'text-[var(--text-muted)]';
    const label = e.actor || t(`cloudHistory.actor.${e.actor_kind}` as never) || e.actor_kind;
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        <Icon size={13} className={`${color} shrink-0`} />
        <span className="truncate">{label}</span>
      </span>
    );
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-4 py-2.5 border-b border-[hsl(var(--border))] flex items-center justify-between gap-3 shrink-0 bg-[hsl(var(--card))]">
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
          <History size={13} />
          {t('cloudHistory.hint')}
        </span>
        <span className="text-[11px] text-[var(--text-muted)] shrink-0">
          {t('cloudHistory.count', { count: events.length })}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 md:p-4">
        <DataTable
          rows={events}
          keyOf={(e) => String(e.id)}
          loading={loading}
          density="compact"
          empty={
            <EmptyState
              icon={Cloud}
              title={t('cloudHistory.emptyTitle')}
              description={t('cloudHistory.emptyDesc')}
            />
          }
          columns={[
            {
              key: 'when',
              header: t('cloudHistory.colWhen'),
              width: '9rem',
              mono: true,
              render: (e) => formatWhen(e.ts),
            },
            {
              key: 'actor',
              header: t('cloudHistory.colActor'),
              width: 'minmax(7rem,1fr)',
              render: actorCell,
            },
            {
              key: 'action',
              header: t('cloudHistory.colAction'),
              width: '7rem',
              render: (e) => {
                const Icon = ACTION_ICON[e.action];
                return (
                  <StatusBadge tone={ACTION_TONE[e.action] ?? 'neutral'}>
                    <span className="flex items-center gap-1">
                      {Icon && <Icon size={11} />}
                      {t(`cloudHistory.action.${e.action}` as never) || e.action}
                    </span>
                  </StatusBadge>
                );
              },
            },
            {
              key: 'path',
              header: t('cloudHistory.colPath'),
              width: 'minmax(0,2.4fr)',
              mono: true,
              render: (e) => (
                <span className="truncate block" title={e.detail ? `${e.path} (${e.detail})` : e.path}>
                  {e.path || '—'}
                  {e.detail && (
                    <span className="ml-1.5 text-[var(--text-muted)]">({e.detail})</span>
                  )}
                </span>
              ),
            },
            {
              key: 'size',
              header: t('cloudHistory.colSize'),
              width: '5.5rem',
              align: 'right',
              mono: true,
              render: (e) => formatSize(e.size),
            },
          ]}
        />

        {hasMore && (
          <div className="flex justify-center py-3">
            <button
              className="text-[12px] px-3 py-1.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              onClick={() => void load(events[events.length - 1]?.id ?? 0)}
            >
              {t('cloudHistory.loadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
