'use client';

import { useCallback, useState } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, Pause, X, AlertTriangle,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type BatchJob } from '@/lib/voiceStudioApi';

interface BatchJobRowProps {
  job: BatchJob;
  onChanged: () => void;
}

const STATE_BADGE: Record<BatchJob['state'], string> = {
  queued: 'bg-[rgba(148,163,184,0.15)] text-[var(--text-secondary)]',
  running: 'bg-[rgba(59,130,246,0.15)] text-[var(--primary-color)]',
  done: 'bg-[rgba(34,197,94,0.15)] text-[var(--success-color)]',
  cancelled: 'bg-[rgba(148,163,184,0.15)] text-[var(--text-muted)]',
  failed: 'bg-[rgba(239,68,68,0.15)] text-[var(--danger-color)]',
};

export default function BatchJobRow({ job, onChanged }: BatchJobRowProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const onCancel = useCallback(async () => {
    if (!confirm(t('voiceStudio.batch.confirmCancel'))) return;
    setBusy(true);
    try {
      await voiceStudioApi.cancelBatch(job.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [job.id, t, onChanged]);

  const pct = job.total_lines > 0 ? Math.min(100, (job.completed_lines / job.total_lines) * 100) : 0;
  const isActive = job.state === 'queued' || job.state === 'running';
  const hasZip = !!job.has_zip;
  const stateClass = STATE_BADGE[job.state] || STATE_BADGE.queued;

  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`px-1.5 py-0.5 rounded text-[0.6875rem] font-medium ${stateClass} uppercase tracking-wide`}>
          {t(`voiceStudio.batch.state.${job.state}`)}
        </span>
        <span className="text-[0.8125rem] font-medium text-[var(--text-primary)] truncate">
          {job.label || job.id.slice(0, 8)}
        </span>
        <span className="ml-1 text-[0.6875rem] text-[var(--text-muted)] font-mono">
          {job.completed_lines}/{job.total_lines}
          {job.error_lines > 0 && (
            <span className="ml-1 text-[var(--warning-color)]">· {job.error_lines} err</span>
          )}
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          {isActive && (
            <button
              onClick={onCancel}
              disabled={busy}
              className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--danger-color)] hover:border-[var(--danger-color)] cursor-pointer transition-all disabled:opacity-50"
              title={t('voiceStudio.batch.cancel')}
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
            </button>
          )}
          {hasZip && (
            <a
              href={voiceStudioApi.getBatchDownloadUrl(job.id)}
              download={`voicestudio-batch-${job.id}.zip`}
              className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] no-underline cursor-pointer transition-all"
              title={t('voiceStudio.batch.download')}
            >
              <Download size={11} />
            </a>
          )}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mt-1.5 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            job.state === 'failed'
              ? 'bg-[var(--danger-color)]'
              : job.state === 'done'
              ? 'bg-[var(--success-color)]'
              : job.state === 'cancelled'
              ? 'bg-[var(--text-muted)]'
              : 'bg-[var(--primary-color)]'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Times + log toggle */}
      <div className="mt-1 flex items-center text-[0.6875rem] text-[var(--text-muted)] gap-2">
        {job.started_at && <span>started {formatRelative(job.started_at)}</span>}
        {job.finished_at && <span>finished {formatRelative(job.finished_at)}</span>}
        {job.log_text && (
          <button
            onClick={() => setLogOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer"
          >
            {logOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            log
          </button>
        )}
        {!job.log_text && job.state === 'done' && (
          <span className="ml-auto inline-flex items-center gap-1 text-[var(--success-color)]">
            <CheckCircle2 size={11} />
            ok
          </span>
        )}
        {!job.log_text && job.state === 'failed' && (
          <span className="ml-auto inline-flex items-center gap-1 text-[var(--danger-color)]">
            <AlertTriangle size={11} />
            failed
          </span>
        )}
      </div>

      {logOpen && job.log_text && (
        <pre className="mt-2 max-h-40 overflow-auto px-2 py-1.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.6875rem] text-[var(--text-secondary)] font-mono whitespace-pre-wrap">
          {job.log_text}
        </pre>
      )}
    </div>
  );
}

function formatRelative(isoUtc: string): string {
  const t = Date.parse(isoUtc);
  if (!Number.isFinite(t)) return isoUtc;
  const delta = Date.now() - t;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
