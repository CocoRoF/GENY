'use client';

import { useI18n } from '@/lib/i18n';

export default function ToolsPage() {
  const { t } = useI18n();
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-center">
      <h2 className="text-[1rem] font-semibold mb-2">{t('voiceStudio.placeholder.tools.title')}</h2>
      <p className="text-[0.875rem] text-[var(--text-muted)]">
        {t('voiceStudio.placeholder.tools.body')}
      </p>
    </div>
  );
}
