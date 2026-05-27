'use client';

import { ReactNode } from 'react';
import SideNav from '@/components/voice-studio/SideNav';
import { useI18n } from '@/lib/i18n';

export default function VoiceStudioLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <SideNav />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center h-14 px-4 md:px-6 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0">
          <h1 className="text-[0.9375rem] font-semibold">{t('voiceStudio.title')}</h1>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
