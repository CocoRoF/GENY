'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const DISMISS_KEY = 'dismissed.voice-studio-banner';

export default function StudioPromoBanner() {
  const { t } = useI18n();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setShow(localStorage.getItem(DISMISS_KEY) !== '1');
  }, []);

  if (!show) return null;

  const dismiss = () => {
    if (typeof window !== 'undefined') localStorage.setItem(DISMISS_KEY, '1');
    setShow(false);
  };

  return (
    <div className="mx-4 mt-3 flex items-center gap-3 px-4 py-2 rounded-lg border border-[rgba(59,130,246,0.25)] bg-[rgba(59,130,246,0.06)] text-[0.8125rem]">
      <Sparkles size={14} className="text-[var(--primary-color)] shrink-0" />
      <span className="flex-1 text-[var(--text-secondary)]">{t('ttsVoice.studioPromoBanner.title')}</span>
      <Link
        href="/voice-studio"
        className="px-2.5 py-1 rounded-md bg-[var(--primary-color)] text-white text-[0.75rem] font-medium no-underline hover:opacity-90 transition-opacity"
      >
        {t('ttsVoice.studioPromoBanner.cta')}
      </Link>
      <button
        onClick={dismiss}
        title={t('ttsVoice.studioPromoBanner.dismiss')}
        className="flex items-center justify-center w-6 h-6 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}
