'use client';

import { useCallback, useEffect, useState } from 'react';
import { Database, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type CacheStats } from '@/lib/voiceStudioApi';

/**
 * Cache stats card. Backed by the legacy ``/api/tts/cache/{stats,}``
 * endpoints — Voice Studio doesn't ship a duplicate cache; we just
 * surface the existing TTS cache so the user can clear it from the
 * Settings page.
 */
export default function CacheCard() {
  const { t } = useI18n();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const s = await voiceStudioApi.getCacheStats(signal);
      setStats(s);
      setError(null);
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const onClear = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('voiceStudio.settings.cache.confirmClear'))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await voiceStudioApi.clearCache();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [t, load]);

  const sizeLabel = formatSize(stats?.size_mb, stats?.size_bytes);
  const maxLabel = stats?.max_size_mb ? `${stats.max_size_mb} MB` : '—';
  const ttl = stats?.ttl_hours ? `${stats.ttl_hours} h` : '—';
  const hits = stats?.hit_count ?? 0;
  const misses = stats?.miss_count ?? 0;
  const rate = stats?.hit_rate !== undefined ? `${(stats.hit_rate * 100).toFixed(1)}%` : '—';

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Database size={14} className="text-[var(--text-muted)]" />
        <h2 className="text-[0.9375rem] font-semibold">{t('voiceStudio.settings.cache.title')}</h2>
        <button
          onClick={() => load()}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-[0.6875rem] text-[var(--text-muted)] hover:text-[var(--primary-color)] bg-transparent border-none cursor-pointer transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[0.8125rem]">
        <Stat label={t('voiceStudio.settings.cache.size')} value={sizeLabel} />
        <Stat label={t('voiceStudio.settings.cache.entries')} value={stats?.entry_count ?? '—'} />
        <Stat label={t('voiceStudio.settings.cache.hits')} value={hits} />
        <Stat label={t('voiceStudio.settings.cache.misses')} value={misses} />
        <Stat label={t('voiceStudio.settings.cache.hitRate')} value={rate} />
        <Stat label={t('voiceStudio.settings.cache.ttl')} value={ttl} extra={`${t('voiceStudio.settings.cache.max')} ${maxLabel}`} />
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onClear}
          disabled={busy || loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--danger-color)] hover:border-[var(--danger-color)] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {t('voiceStudio.settings.cache.clear')}
        </button>
        <span className="text-[0.6875rem] text-[var(--text-muted)]">
          {t('voiceStudio.settings.cache.note')}
        </span>
      </div>
    </section>
  );
}

function Stat({ label, value, extra }: { label: string; value: string | number; extra?: string }) {
  return (
    <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2">
      <div className="text-[0.6875rem] text-[var(--text-muted)]">{label}</div>
      <div className="text-[0.875rem] font-mono text-[var(--text-primary)]">{value}</div>
      {extra && <div className="text-[0.625rem] text-[var(--text-muted)] mt-0.5">{extra}</div>}
    </div>
  );
}

function formatSize(size_mb?: number, size_bytes?: number): string {
  if (size_mb !== undefined) return `${size_mb.toFixed(2)} MB`;
  if (size_bytes !== undefined) return `${(size_bytes / 1024 / 1024).toFixed(2)} MB`;
  return '—';
}
