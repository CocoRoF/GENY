'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type BatchJob } from '@/lib/voiceStudioApi';
import { subscribeEvents } from '@/lib/voiceStudioEvents';
import BatchJobRow from '@/components/voice-studio/BatchJobRow';
import BatchUploader from '@/components/voice-studio/BatchUploader';

export default function BatchPage() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await voiceStudioApi.listBatches();
      setJobs(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe to SSE; refresh on any batch.* event.
  useEffect(() => {
    const unsub = subscribeEvents((ev) => {
      if (!ev.kind?.startsWith('batch.')) return;
      // Coalesce bursts: debounce 200ms.
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refresh();
      }, 200);
    });
    return () => {
      unsub();
      if (refreshTimer.current) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refresh]);

  const onStarted = useCallback(() => {
    // Immediate refresh; SSE will follow with progress.
    refresh();
  }, [refresh]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
      <BatchUploader onStarted={onStarted} />

      <section className="space-y-2">
        <h3 className="text-[0.875rem] font-semibold text-[var(--text-primary)]">
          {t('voiceStudio.batch.jobsHeader')}
        </h3>
        {error && (
          <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
            {error}
          </div>
        )}
        {jobs.length === 0 && !error && (
          <p className="text-[0.875rem] text-[var(--text-muted)] py-6 text-center">
            {t('voiceStudio.batch.noJobs')}
          </p>
        )}
        {jobs.map((j) => (
          <BatchJobRow key={j.id} job={j} onChanged={refresh} />
        ))}
      </section>
    </div>
  );
}
