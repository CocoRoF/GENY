'use client';

import { useI18n } from '@/lib/i18n';

export default function CloneDesignPage() {
  const { t } = useI18n();
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-center">
      <h2 className="text-[1rem] font-semibold mb-2">{t('voiceStudio.placeholder.cloneDesign.title')}</h2>
      <p className="text-[0.875rem] text-[var(--text-muted)]">
        {t('voiceStudio.placeholder.cloneDesign.body')}
      </p>
    </div>
  );
}
