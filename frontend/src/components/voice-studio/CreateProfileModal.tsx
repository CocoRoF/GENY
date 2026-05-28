'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { ttsApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface CreateProfileModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}

const LANGUAGES = [
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

/**
 * New voice profile creation modal. Replicates the form that used to
 * live in the legacy ``/tts-voice`` page so we can retire that page
 * without losing the profile-creation entry point.
 */
export default function CreateProfileModal({ open, onClose, onCreated }: CreateProfileModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState('ko');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when the modal opens.
  useEffect(() => {
    if (!open) return;
    setName('');
    setDisplayName('');
    setLanguage('ko');
    setBusy(false);
    setError(null);
  }, [open]);

  const submit = useCallback(async () => {
    if (!name || !displayName) return;
    setBusy(true);
    setError(null);
    try {
      const safeName = name.replace(/[^\p{L}\p{N}_-]/gu, '_');
      await ttsApi.createProfile({
        name: safeName,
        display_name: displayName,
        language,
      });
      onCreated(safeName);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [name, displayName, language, onCreated, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[0.9375rem] font-semibold">{t('ttsVoice.newProfile')}</h3>
          <button
            onClick={onClose}
            disabled={busy}
            className="flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <Field label={t('ttsVoice.profileName')} hint={t('ttsVoice.profileNameHint')}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my_voice"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.875rem] outline-none focus:border-[var(--primary-color)]"
            />
          </Field>

          <Field label={t('ttsVoice.displayName')}>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('ttsVoice.displayNamePlaceholder')}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.875rem] outline-none focus:border-[var(--primary-color)]"
            />
          </Field>

          <Field label={t('ttsVoice.language')}>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.875rem] outline-none focus:border-[var(--primary-color)]"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </Field>

          {error && (
            <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-color)]">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--text-primary)] cursor-pointer transition-colors disabled:opacity-50"
          >
            {t('ttsVoice.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={busy || !name || !displayName}
            className="ml-auto inline-flex items-center gap-1 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {t('ttsVoice.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[0.75rem] font-medium text-[var(--text-muted)] mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}
