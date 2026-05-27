'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Star, Mic, Globe, ChevronRight } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function VoiceCard({ profile, onActivated }: { profile: VoiceProfile; onActivated: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const refCount = Object.keys(profile.has_refs || {}).length;

  const activate = useCallback(async () => {
    if (profile.active || busy) return;
    setBusy(true);
    try {
      await ttsApi.activateProfile(profile.name);
      onActivated();
    } catch {
      // page-level error UI will surface this on the next reload
    } finally {
      setBusy(false);
    }
  }, [profile.name, profile.active, busy, onActivated]);

  return (
    <div
      className={`rounded-xl border p-3.5 transition-colors ${
        profile.active
          ? 'border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.05)]'
          : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--primary-color)]'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0">
          <Mic size={16} className="text-[var(--text-muted)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-[0.875rem] font-medium truncate">{profile.display_name || profile.name}</p>
            {profile.active && (
              <Star size={11} className="text-[var(--success-color)] shrink-0" fill="currentColor" />
            )}
          </div>
          <p className="text-[0.6875rem] text-[var(--text-muted)] truncate font-mono">{profile.name}</p>
          <div className="flex items-center gap-2 mt-1.5 text-[0.6875rem] text-[var(--text-muted)]">
            {profile.language && (
              <span className="inline-flex items-center gap-1">
                <Globe size={10} />
                {profile.language}
              </span>
            )}
            <span>{t('voiceStudio.voices.refCount', { n: refCount })}</span>
            {profile.is_template && (
              <span className="px-1.5 py-px rounded text-[0.625rem] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] uppercase tracking-wide">
                {t('voiceStudio.voices.template')}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={activate}
          disabled={profile.active || busy}
          className="px-3 py-1.5 rounded-md text-[0.75rem] font-medium border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {profile.active ? t('voiceStudio.voices.active') : t('voiceStudio.voices.activate')}
        </button>
        <Link
          href={{ pathname: '/voice-studio/clone-design', query: { profile: profile.name } }}
          className="ml-auto inline-flex items-center gap-1 text-[0.75rem] text-[var(--text-muted)] hover:text-[var(--primary-color)] no-underline transition-colors"
        >
          {t('voiceStudio.voices.openInDesign')}
          <ChevronRight size={12} />
        </Link>
      </div>
    </div>
  );
}
