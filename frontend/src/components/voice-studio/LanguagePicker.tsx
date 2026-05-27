'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Search, ChevronDown } from 'lucide-react';
import { voiceStudioApi, type LanguageItem } from '@/lib/voiceStudioApi';
import { useI18n } from '@/lib/i18n';

interface LanguagePickerProps {
  /** ISO code (e.g. ``ko``) or ``''`` = let OmniVoice auto-detect. */
  value: string;
  onChange: (code: string) => void;
}

/**
 * Combo select for OmniVoice's 600+ language list. Fetches once per
 * page (cached in :mod:`voiceStudioApi`), filters client-side, exposes
 * a sentinel ``''`` value meaning "auto-detect".
 */
export default function LanguagePicker({ value, onChange }: LanguagePickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [languages, setLanguages] = useState<LanguageItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    voiceStudioApi
      .getLanguages(controller.signal)
      .then((list) => {
        setLanguages(list);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return languages.slice(0, 200);  // cap initial render
    return languages.filter((l) =>
      l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q),
    ).slice(0, 200);
  }, [languages, query]);

  const currentLabel = value
    ? (languages.find((l) => l.code === value)?.name || value)
    : t('voiceStudio.cloneDesign.language.auto');

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] hover:border-[var(--primary-color)] cursor-pointer transition-colors min-w-[180px]"
      >
        <Globe size={12} className="text-[var(--text-muted)]" />
        <span className="flex-1 text-left truncate">{currentLabel}</span>
        <ChevronDown size={12} className="text-[var(--text-muted)]" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-72 max-w-[80vw] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-lg">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)]">
            <Search size={12} className="text-[var(--text-muted)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('voiceStudio.cloneDesign.language.searchPlaceholder')}
              className="bg-transparent border-none outline-none text-[0.8125rem] flex-1 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-[0.8125rem] cursor-pointer transition-colors ${
                value === ''
                  ? 'bg-[var(--primary-subtle)] text-[var(--primary-color)]'
                  : 'hover:bg-[var(--bg-hover)]'
              }`}
            >
              <span className="font-mono text-[0.6875rem] text-[var(--text-muted)] w-12 shrink-0">auto</span>
              <span className="flex-1">{t('voiceStudio.cloneDesign.language.auto')}</span>
            </button>
            {!loaded && (
              <p className="px-3 py-2 text-[0.75rem] text-[var(--text-muted)]">
                {t('voiceStudio.cloneDesign.language.loading')}
              </p>
            )}
            {error && (
              <p className="px-3 py-2 text-[0.75rem] text-[var(--danger-color)]">{error}</p>
            )}
            {loaded && !error && filtered.length === 0 && (
              <p className="px-3 py-2 text-[0.75rem] text-[var(--text-muted)]">
                {t('voiceStudio.cloneDesign.language.noMatch')}
              </p>
            )}
            {filtered.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => {
                  onChange(l.code);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-[0.8125rem] cursor-pointer transition-colors ${
                  value === l.code
                    ? 'bg-[var(--primary-subtle)] text-[var(--primary-color)]'
                    : 'hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className="font-mono text-[0.6875rem] text-[var(--text-muted)] w-12 shrink-0 truncate">
                  {l.code}
                </span>
                <span className="flex-1 truncate">{l.name}</span>
              </button>
            ))}
          </div>
          {loaded && !error && languages.length > 0 && (
            <div className="px-3 py-1.5 border-t border-[var(--border-color)] text-[0.6875rem] text-[var(--text-muted)]">
              {languages.length}개 언어 · {filtered.length}개 표시
            </div>
          )}
        </div>
      )}
    </div>
  );
}
