'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Star, Mic, Globe, ChevronRight } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { EntityCard } from '@/components/common/layout';

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
    <EntityCard
      icon={<Mic />}
      iconTone="neutral"
      title={profile.display_name || profile.name}
      subtitle={profile.name}
      active={profile.active}
      star={
        profile.active ? (
          <Star size={12} className="text-[var(--success-color)]" fill="currentColor" />
        ) : undefined
      }
      footer={
        <>
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
        </>
      }
    >
      <div className="flex items-center gap-2 text-[0.6875rem] text-[var(--text-muted)]">
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
    </EntityCard>
  );
}
