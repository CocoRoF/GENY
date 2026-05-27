'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Dice5 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { PreviewAudioFormat } from '@/lib/voiceStudioApi';

export interface AdvancedParams {
  num_step: number;
  guidance_scale: number;
  speed: number;
  duration_seconds: number;        // 0 = use speed
  denoise: boolean;
  auto_asr: boolean;
  seed: number | '';               // '' = random / omit
  audio_format: PreviewAudioFormat;
  sample_rate: number;
}

export const DEFAULT_ADVANCED_PARAMS: AdvancedParams = {
  num_step: 16,
  guidance_scale: 2.0,
  speed: 1.0,
  duration_seconds: 0,
  denoise: true,
  auto_asr: false,
  seed: '',
  audio_format: 'wav',
  sample_rate: 24000,
};

interface AdvancedParamsPanelProps {
  values: AdvancedParams;
  onChange: (next: AdvancedParams) => void;
}

/**
 * Collapsible OmniVoice advanced parameters panel.
 *
 * Field semantics:
 *   - ``num_step``        — diffusion steps. 8 = speed, 16 = balanced, 32 = quality.
 *   - ``guidance_scale``  — classifier-free guidance.
 *   - ``speed``           — playback rate; 1.0 = neutral.
 *   - ``duration_seconds``— 0 means "use speed", otherwise force this length.
 *   - ``denoise``         — clean the reference audio before clone.
 *   - ``auto_asr``        — let OmniVoice run Whisper on the ref when prompt_text is empty.
 *   - ``seed``            — '' (random) or non-negative int for reproducibility.
 */
export default function AdvancedParamsPanel({ values, onChange }: AdvancedParamsPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const patch = <K extends keyof AdvancedParams>(key: K, val: AdvancedParams[K]) => {
    onChange({ ...values, [key]: val });
  };

  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-[0.8125rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('voiceStudio.cloneDesign.advanced.label')}
      </button>
      {open && (
        <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* num_step */}
          <Field label={t('voiceStudio.cloneDesign.advanced.numStep')}
                 hint="8 = speed · 16 = balanced · 32 = quality">
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

          {/* guidance */}
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

          {/* speed */}
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

          {/* duration */}
          <Field label={t('voiceStudio.cloneDesign.advanced.duration')}
                 hint={t('voiceStudio.cloneDesign.advanced.durationHint')}>
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

          {/* seed */}
          <Field label={t('voiceStudio.cloneDesign.advanced.seed')}>
            <input
              type="number"
              min={0}
              value={values.seed === '' ? '' : values.seed}
              onChange={(e) => {
                const raw = e.target.value;
                patch('seed', raw === '' ? '' : Math.max(0, parseInt(raw, 10) || 0));
              }}
              placeholder={t('voiceStudio.cloneDesign.advanced.seedRandom')}
              className="flex-1 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
            />
            <button
              type="button"
              onClick={() => patch('seed', Math.floor(Math.random() * 1_000_000))}
              title={t('voiceStudio.cloneDesign.advanced.seedRandomize')}
              className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors"
            >
              <Dice5 size={12} />
            </button>
          </Field>

          {/* sample_rate */}
          <Field label={t('voiceStudio.cloneDesign.advanced.sampleRate')}>
            <select
              value={values.sample_rate}
              onChange={(e) => patch('sample_rate', parseInt(e.target.value, 10))}
              className="flex-1 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
            >
              <option value={24000}>24000</option>
              <option value={44100}>44100</option>
              <option value={48000}>48000</option>
            </select>
          </Field>

          {/* audio_format */}
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

          {/* toggles */}
          <Field label={t('voiceStudio.cloneDesign.advanced.toggles')}>
            <label className="flex items-center gap-1.5 text-[0.75rem] text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={values.denoise}
                onChange={(e) => patch('denoise', e.target.checked)}
              />
              {t('voiceStudio.cloneDesign.advanced.denoise')}
            </label>
            <label className="flex items-center gap-1.5 text-[0.75rem] text-[var(--text-secondary)] cursor-pointer ml-3"
                   title={t('voiceStudio.cloneDesign.advanced.autoAsrHint')}>
              <input
                type="checkbox"
                checked={values.auto_asr}
                onChange={(e) => patch('auto_asr', e.target.checked)}
              />
              {t('voiceStudio.cloneDesign.advanced.autoAsr')}
            </label>
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">{label}</label>
      <div className="flex items-center gap-2">{children}</div>
      {hint && <p className="mt-0.5 text-[0.625rem] text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}
