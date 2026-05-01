/**
 * Lightweight i18n module.
 *
 * Architecture:
 *   - Translations live in flat TS files (en.ts, ko.ts) — fully typed.
 *   - A Zustand store holds the current locale and exposes `t()`.
 *   - `t()` resolves dot-path keys with {var} interpolation.
 *   - Missing Korean keys automatically fall back to English.
 *   - `setLocale` writes the choice to localStorage so it survives
 *     reloads on every route. <LocaleHydrator/> at the root layout
 *     reads it back on mount; an inline init script in <head> sets
 *     <html lang> before hydration to avoid a flash of English.
 *   - Language preference also syncs bidirectionally with the backend
 *     LanguageConfig via the /api/config/* endpoints (best-effort,
 *     for cross-device consistency).
 *
 * Usage in components:
 *   import { useI18n } from '@/lib/i18n';
 *   const { t, locale, setLocale } = useI18n();
 *   <span>{t('sidebar.sessions')}</span>
 */

import { create } from 'zustand';
import en, { type Translations } from './en';
import ko from './ko';

// ─── Types ───
export type Locale = 'en' | 'ko';

const locales: Record<Locale, Translations> = { en, ko };

// localStorage key — also used by the inline init script in
// app/layout.tsx (keep them in sync).
export const LOCALE_STORAGE_KEY = 'geny-locale';

// Read localStorage synchronously at module load so the Zustand
// store's *initial* state already matches the persisted locale.
// Without this, components render once with English defaults
// (the store's initial state) before LocaleHydrator's useEffect
// flips it to Korean — a visible "flash of English" on every
// route change. The inline <head> script handles ``<html lang>``
// but not React state, so this seed is the React-side equivalent.
function readPersistedLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === 'ko' || raw === 'en') return raw;
  } catch {
    /* private mode / quota — fall through */
  }
  return 'en';
}

// Module-level current locale (kept in sync by the Zustand store's setLocale)
let currentLocale: Locale = readPersistedLocale();

// ─── Deep-get by dot-path ───
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((o: any, k) => o?.[k], obj);
}

// ─── Interpolation: replace {key} placeholders ───
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
}

// ─── The translation function (standalone, no React) ───
export function translate(key: string, vars?: Record<string, string | number>): string;
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string;
export function translate(localeOrKey: Locale | string, keyOrVars?: string | Record<string, string | number>, maybeVars?: Record<string, string | number>): string {
  let locale: Locale;
  let key: string;
  let vars: Record<string, string | number> | undefined;

  // Overload resolution: if first arg is a known locale AND second arg is a string, treat as (locale, key, vars?)
  if ((localeOrKey === 'en' || localeOrKey === 'ko') && typeof keyOrVars === 'string') {
    locale = localeOrKey as Locale;
    key = keyOrVars;
    vars = maybeVars;
  } else {
    // Auto-detect locale from module-level current locale
    locale = currentLocale;
    key = localeOrKey;
    vars = typeof keyOrVars === 'object' ? keyOrVars as Record<string, string | number> : undefined;
  }

  let value = getByPath(locales[locale], key);
  // Fallback to English
  if (value === undefined || value === null) {
    value = getByPath(locales.en, key);
  }
  if (typeof value === 'string') return interpolate(value, vars);
  // For non-string values (arrays/objects) just return the raw value via JSON
  if (value !== undefined && value !== null) return String(value);
  // Ultimate fallback: return the key itself
  return key;
}

/**
 * Like `translate` but returns the raw value (useful for arrays/objects
 * like `main.sections` or `main.tips`).
 */
export function translateRaw<T = unknown>(key: string): T;
export function translateRaw<T = unknown>(locale: Locale, key: string): T;
export function translateRaw<T = unknown>(localeOrKey: Locale | string, maybeKey?: string): T {
  let locale: Locale;
  let key: string;

  if ((localeOrKey === 'en' || localeOrKey === 'ko') && typeof maybeKey === 'string') {
    locale = localeOrKey as Locale;
    key = maybeKey;
  } else {
    locale = currentLocale;
    key = localeOrKey;
  }

  let value = getByPath(locales[locale], key) as T | undefined;
  if (value === undefined || value === null) {
    value = getByPath(locales.en, key) as T;
  }
  return value as T;
}

// ─── Zustand store ───
interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  tRaw: <T = unknown>(key: string) => T;
}

export const useI18n = create<I18nState>((set, get) => ({
  // Seed from localStorage at store-creation time so the very first
  // render of every route — including new tabs opened from the main
  // page — already reflects the user's locale choice. LocaleHydrator
  // still runs after mount to reconcile with the backend
  // LanguageConfig (cross-device sync), but the in-tab UX no longer
  // flashes English on initial paint.
  locale: currentLocale,

  setLocale: (locale) => {
    currentLocale = locale;
    // Sync HTML lang attribute
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
    // Persist so a reload on any route keeps the user's choice.
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      } catch {
        /* private mode / quota — best-effort */
      }
    }
    set({
      locale,
      t: (key, vars) => translate(locale, key, vars),
      tRaw: <T = unknown>(key: string) => translateRaw<T>(locale, key),
    });
  },

  t: (key, vars) => translate(currentLocale, key, vars),
  tRaw: <T = unknown>(key: string) => translateRaw<T>(currentLocale, key),
}));

// Re-export types and translations for convenience
export type { Translations };
export { en, ko };
