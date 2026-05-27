'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Save } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  voiceStudioApi,
  type OmniVoiceDefaults,
  type PreviewAudioFormat,
} from '@/lib/voiceStudioApi';

const INITIAL: OmniVoiceDefaults = {
  num_step: 16,
  guidance_scale: 2.0,
  speed: 1.0,
  duration_seconds: 0,
  denoise: true,
  audio_format: 'wav',
};

export default function OmniVoiceDefaultsCard() {
  const { t } = useI18n();
  const [values, setValues] = useState<OmniVoiceDefaults>(INITIAL);
  const [pristine, setPristine] = useState<OmniVoiceDefaults>(INITIAL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const v = await voiceStudioApi.getOmniVoiceDefaults(signal);
      setValues(v);
      setPristine(v);
      setError(null);
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const dirty =
    values.num_step !== pristine.num_step ||
    Math.abs(values.guidance_scale - pristine.guidance_scale) > 1e-6 ||
    Math.abs(values.speed - pristine.speed) > 1e-6 ||
    Math.abs(values.duration_seconds - pristine.duration_seconds) > 1e-6 ||
    values.denoise !== pristine.denoise ||
    values.audio_format !== pristine.audio_format;

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const v = await voiceStudioApi.putOmniVoiceDefaults(values);
      setValues(v);
      setPristine(v);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [values]);

  const patch = <K extends keyof OmniVoiceDefaults>(key: K, val: OmniVoiceDefaults[K]) =>
    setValues((prev) => ({ ...prev, [key]: val }));

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[0.9375rem] font-semibold">
          {t('voiceStudio.settings.omnivoiceDefaults.title')}
        </h2>
      </div>
      <p className="text-[0.6875rem] text-[var(--text-muted)]">
        {t('voiceStudio.settings.omnivoiceDefaults.hint')}
      </p>

      {error && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}
      {savedAt && !dirty && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(34,197,94,0.1)] text-[var(--success-color)] border border-[rgba(34,197,94,0.2)] inline-flex items-center gap-1">
          <Check size={12} />
          {t('voiceStudio.settings.omnivoiceDefaults.saved')}
        </div>
      )}

      {loading ? (
        <p className="text-[0.875rem] text-[var(--text-muted)] py-6 text-center inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          {t('voiceStudio.settings.omnivoiceDefaults.loading')}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={t('voiceStudio.cloneDesign.advanced.numStep')}>
            <input
              type="range"
              min={1}
              max={64}
              step={1}
              value={values.num_step}
              onChange={(e) => patch('num_step', parseInt(e.target.value, 10))}
              className="flex-1"
            />
            <span className="text-[0.75rem] font-mono text-[var(--text-secondary)] w-10 text-right">
              {values.num_step}
            </span>
          </Field>

          <Field label={t('voiceStudio.cloneDesign.advanced.guidance')}>
            <input
              type="range"
              min={0}
              max={6}
              step={0.1}
              value={values.guidance_scale}
              onChange={(e) => patch('guidance_scale', parseFloat(e.target.value))}
              className="flex-1"
            />
            <span className="text-[0.75rem] font-mono text-[var(--text-secondary)] w-10 text-right">
              {values.guidance_scale.toFixed(1)}
            </span>
          </Field>

          <Field label={t('voiceStudio.cloneDesign.advanced.speed')}>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.05}
              value={values.speed}
              onChange={(e) => patch('speed', parseFloat(e.target.value))}
              className="flex-1"
            />
            <span className="text-[0.75rem] font-mono text-[var(--text-secondary)] w-10 text-right">
              {values.speed.toFixed(2)}x
            </span>
          </Field>

          <Field label={t('voiceStudio.cloneDesign.advanced.duration')}>
            <input
              type="number"
              min={0}
              max={120}
              step={0.5}
              value={values.duration_seconds || ''}
              onChange={(e) => patch('duration_seconds', parseFloat(e.target.value) || 0)}
              placeholder="0"
              className="flex-1 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
            />
            <span className="text-[0.75rem] text-[var(--text-muted)]">sec</span>
          </Field>

          <Field label={t('voiceStudio.cloneDesign.advanced.audioFormat')}>
            <select
              value={values.audio_format}
              onChange={(e) => patch('audio_format', e.target.value as PreviewAudioFormat)}
              className="flex-1 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
            >
              <option value="wav">wav</option>
              <option value="mp3">mp3</option>
              <option value="ogg">ogg</option>
              <option value="pcm">pcm</option>
            </select>
          </Field>

          <Field label={t('voiceStudio.cloneDesign.advanced.denoise')}>
            <label className="inline-flex items-center gap-1.5 text-[0.75rem] text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={values.denoise}
                onChange={(e) => patch('denoise', e.target.checked)}
              />
              {values.denoise ? 'on' : 'off'}
            </label>
          </Field>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {t('voiceStudio.settings.omnivoiceDefaults.save')}
        </button>
        {dirty && (
          <span className="text-[0.6875rem] text-[var(--warning-color)]">
            {t('voiceStudio.settings.omnivoiceDefaults.unsaved')}
          </span>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">{label}</label>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
