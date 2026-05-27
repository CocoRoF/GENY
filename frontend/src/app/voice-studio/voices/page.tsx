'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Mic, Search } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import VoiceCard from '@/components/voice-studio/VoiceCard';

type Filter = 'all' | 'templates' | 'mine';

export default function VoicesPage() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await ttsApi.listProfiles();
      setProfiles(res.profiles || []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return profiles.filter((p) => {
      if (filter === 'templates' && !p.is_template) return false;
      if (filter === 'mine' && p.is_template) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.display_name || '').toLowerCase().includes(q) ||
        (p.language || '').toLowerCase().includes(q)
      );
    });
  }, [profiles, filter, query]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="text-[var(--text-muted)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('voiceStudio.voices.searchPlaceholder')}
            className="bg-transparent border-none outline-none text-[0.8125rem] flex-1 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
        </div>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
          {(['all', 'templates', 'mine'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-[0.6875rem] font-medium rounded transition-all duration-150 border-none cursor-pointer ${
                filter === f
                  ? 'bg-[var(--primary-color)] text-white shadow-sm'
                  : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t(`voiceStudio.voices.filter.${f}`)}
            </button>
          ))}
        </div>
        <span className="text-[0.75rem] text-[var(--text-muted)] ml-auto">
          {t('voiceStudio.voices.count', { n: filtered.length })}
        </span>
      </div>

      {/* States */}
      {loading && (
        <p className="text-[0.875rem] text-[var(--text-muted)] py-8 text-center">
          {t('voiceStudio.voices.loading')}
        </p>
      )}
      {error && (
        <div className="px-4 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="py-12 flex flex-col items-center text-center gap-2 text-[var(--text-muted)]">
          <Mic size={28} className="opacity-40" />
          <p className="text-[0.875rem]">{t('voiceStudio.voices.empty')}</p>
        </div>
      )}

      {/* Grid */}
      {!loading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((p) => (
            <VoiceCard key={p.name} profile={p} onActivated={load} />
          ))}
        </div>
      )}
    </div>
  );
}
