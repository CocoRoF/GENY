'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import SynthesizeCard from '@/components/voice-studio/SynthesizeCard';
import EmotionRefSection from '@/components/voice-studio/EmotionRefSection';

/**
 * ``useSearchParams`` requires a Suspense boundary at build time (Next.js
 * App Router static-export rule). Outer page provides the boundary,
 * inner ``CloneDesignInner`` reads the query.
 */
export default function CloneDesignPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CloneDesignInner />
    </Suspense>
  );
}

function PageLoading() {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-center px-6 py-12 text-[var(--text-muted)] gap-2 text-[0.875rem]">
      <Loader2 size={14} className="animate-spin" />
      {t('voiceStudio.cloneDesign.loading')}
    </div>
  );
}

function CloneDesignInner() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const profileFromUrl = searchParams.get('profile') || undefined;

  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [selectedName, setSelectedName] = useState<string | undefined>(profileFromUrl);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      setLoading(true);
      const res = await ttsApi.listProfiles();
      setProfiles(res.profiles || []);
      setSelectedName((prev) => {
        if (prev && res.profiles?.some((p) => p.name === prev)) return prev;
        const active = res.profiles?.find((p) => p.active);
        return (active || res.profiles?.[0])?.name;
      });
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const selected = useMemo(
    () => profiles.find((p) => p.name === selectedName) || null,
    [profiles, selectedName],
  );

  if (loading) return <PageLoading />;

  if (error) {
    return (
      <div className="max-w-2xl mx-6 mt-6 px-4 py-3 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
        {error}
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
      {/* Profile selector */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[0.75rem] text-[var(--text-muted)]">
          {t('voiceStudio.cloneDesign.profile')}
        </span>
        <select
          value={selectedName ?? ''}
          onChange={(e) => setSelectedName(e.target.value || undefined)}
          className="px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)] min-w-[200px]"
        >
          {profiles.length === 0 && (
            <option value="">{t('voiceStudio.cloneDesign.noProfile')}</option>
          )}
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.display_name || p.name}{p.active ? ' ★' : ''}
            </option>
          ))}
        </select>
        {selected?.is_template && (
          <span className="px-2 py-0.5 rounded text-[0.625rem] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] uppercase tracking-wide">
            {t('voiceStudio.voices.template')}
          </span>
        )}
      </div>

      <SynthesizeCard profile={selected} />

      {selected && <EmotionRefSection profile={selected} onRefresh={loadProfiles} />}
    </div>
  );
}
