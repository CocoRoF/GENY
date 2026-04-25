'use client';

/**
 * Crash-recovery checkpoint picker.
 *
 * Calls `agentApi.checkpointsList` on open, renders one row per
 * checkpoint with the wall-clock timestamp + size, and on selection
 * dispatches `agentApi.checkpointsRestore`. Pure operator UI; the
 * actual state rebuild happens server-side.
 */

import { useCallback, useEffect, useState } from 'react';
import { agentApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { History, X, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface CheckpointRow {
  checkpoint_id: string;
  written_at: number;
  size_bytes: number;
}

interface Props {
  sessionId: string;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export default function RestoreCheckpointModal({ sessionId, onClose }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<CheckpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ id: string; count: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    agentApi
      .checkpointsList(sessionId)
      .then((resp) => {
        if (!cancelled) setItems(resp.checkpoints);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handleRestore = useCallback(
    async (checkpointId: string) => {
      setRestoring(checkpointId);
      setError(null);
      try {
        const resp = await agentApi.checkpointsRestore(sessionId, checkpointId);
        setRestored({ id: checkpointId, count: resp.messages_restored });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRestoring(null);
      }
    },
    [sessionId],
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={restoring ? undefined : onClose}
    >
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[520px] max-h-[85vh] flex flex-col shadow-[var(--shadow-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center py-4 px-6 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-[rgba(59,130,246,0.10)] text-[var(--primary-color)]">
              <History size={15} />
            </span>
            <h3 className="text-[1rem] font-semibold text-[var(--text-primary)]">
              {t('restore.modalTitle')}
            </h3>
          </div>
          <button
            disabled={restoring !== null}
            className="flex items-center justify-center w-8 h-8 rounded-[var(--border-radius)] bg-transparent border-none text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-[var(--text-muted)] text-[0.8125rem]">
              <Loader2 size={14} className="animate-spin" />
              {t('restore.loadingList')}
            </div>
          )}

          {!loading && items.length === 0 && !error && (
            <div className="text-center py-8 text-[var(--text-muted)] text-[0.8125rem]">
              {t('restore.empty')}
            </div>
          )}

          {!loading && items.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {items.map((row) => {
                const isRestoringThis = restoring === row.checkpoint_id;
                const isRestored = restored?.id === row.checkpoint_id;
                return (
                  <li
                    key={row.checkpoint_id}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[0.75rem] font-mono text-[var(--text-primary)] truncate">
                        {row.checkpoint_id}
                      </div>
                      <div className="text-[0.625rem] text-[var(--text-muted)] mt-0.5">
                        {formatTime(row.written_at)} · {formatBytes(row.size_bytes)}
                      </div>
                    </div>
                    {isRestored ? (
                      <span className="inline-flex items-center gap-1 text-[var(--success-color)] text-[0.6875rem]">
                        <CheckCircle2 size={12} />
                        {t('restore.restoredCount', { count: String(restored?.count ?? 0) })}
                      </span>
                    ) : (
                      <button
                        disabled={restoring !== null}
                        className="py-1 px-3 bg-[var(--primary-color)] hover:bg-[var(--primary-hover)] text-white text-[0.6875rem] font-medium rounded-md cursor-pointer transition-all border-none disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => handleRestore(row.checkpoint_id)}
                      >
                        {isRestoringThis ? t('restore.restoringBtn') : t('restore.restoreBtn')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {error && (
            <div className="mt-3 inline-flex items-start gap-2 text-[0.75rem] text-[var(--danger-color)] bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.2)] rounded-md px-3 py-2">
              <AlertTriangle size={12} className="mt-[1px] shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end items-center gap-3 py-4 px-6 border-t border-[var(--border-color)]">
          <button
            disabled={restoring !== null}
            className="py-2 px-4 bg-transparent hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[0.8125rem] font-medium rounded-[var(--border-radius)] cursor-pointer transition-all duration-150 border border-[var(--border-color)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
