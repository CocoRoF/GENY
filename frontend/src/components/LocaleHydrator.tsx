'use client';

/**
 * LocaleHydrator — restores the user's locale on every route.
 *
 * Mounted once in the root layout so every page (including
 * /environments, /wiki, /opsidian, /tts-voice, /setup, etc.) gets
 * the same hydration path.
 *
 * Order of operations:
 *
 *   1. Read localStorage for the last-set locale and apply it
 *      synchronously on the first effect tick. This is the primary
 *      source — it survives reloads with no network round-trip.
 *
 *   2. Fire a best-effort GET to the backend LanguageConfig. If the
 *      server has a different value (e.g. user changed it on another
 *      device), promote that to the source of truth. If the request
 *      fails (no auth, offline) we silently keep the localStorage
 *      value.
 *
 * The inline init script in <head> already pre-sets <html lang> from
 * localStorage before hydration, so no flash of English even on the
 * initial paint.
 */

import { useEffect } from 'react';
import { configApi } from '@/lib/api';
import { LOCALE_STORAGE_KEY, useI18n, type Locale } from '@/lib/i18n';

export default function LocaleHydrator() {
  const setLocale = useI18n((s) => s.setLocale);

  useEffect(() => {
    let stored: Locale | null = null;
    try {
      const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (raw === 'en' || raw === 'ko') stored = raw;
    } catch {
      /* private mode — best-effort */
    }
    if (stored) setLocale(stored);

    configApi
      .get('language')
      .then((res) => {
        const lang = res.values?.language;
        if ((lang === 'en' || lang === 'ko') && lang !== stored) {
          setLocale(lang as Locale);
        }
      })
      .catch(() => {
        /* best-effort */
      });
  }, [setLocale]);

  return null;
}
