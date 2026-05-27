'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { VoiceProfile } from '@/lib/api';
import {
  voiceStudioApi,
  type PreviewMode,
  type PreviewParams,
  type PreviewResult,
} from '@/lib/voiceStudioApi';
import AdvancedParamsPanel, {
  DEFAULT_ADVANCED_PARAMS,
  type AdvancedParams,
} from './AdvancedParamsPanel';
import InstructPanel from './InstructPanel';
import LanguagePicker from './LanguagePicker';
import WaveformPreview from './WaveformPreview';

const EMOTIONS = [
  'neutral', 'joy', 'anger', 'sadness', 'fear', 'surprise', 'disgust', 'smirk',
] as const;
type Emotion = (typeof EMOTIONS)[number];

const EMOTION_COLORS: Record<string, string> = {
  neutral: 'bg-gray-400',
  joy: 'bg-yellow-400',
  anger: 'bg-red-500',
  sadness: 'bg-blue-400',
  fear: 'bg-purple-400',
  surprise: 'bg-orange-400',
  disgust: 'bg-green-500',
  smirk: 'bg-pink-400',
};

interface SynthesizeCardProps {
  profile: VoiceProfile | null;
}

/**
 * The Synthesize card — full OmniVoice parameter surface in one panel.
 *
 * Posts to ``/api/voice-studio/synth/preview`` via :mod:`voiceStudioApi`.
 * Clone mode resolves the reference audio server-side from the selected
 * profile + emotion; design mode bypasses ref entirely and uses the
 * instruct string.
 */
export default function SynthesizeCard({ profile }: SynthesizeCardProps) {
  const { t } = useI18n();
  const [text, setText] = useState('안녕하세요. 오늘은 날씨가 좋네요.');
  const [mode, setMode] = useState<PreviewMode>('clone');
  const [emotion, setEmotion] = useState<Emotion>('neutral');
  const [language, setLanguage] = useState('');
  const [instruct, setInstruct] = useState('');
  const [advanced, setAdvanced] = useState<AdvancedParams>(DEFAULT_ADVANCED_PARAMS);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Revoke previous blob URL when result changes / on unmount.
  useEffect(() => {
    return () => {
      if (result?.blobUrl) URL.revokeObjectURL(result.blobUrl);
    };
  }, [result]);

  // When the user switches profile, reset error + (optional) emotion if
  // the current one has no ref. We don't auto-flip emotion to avoid
  // surprising the user; clone-mode errors will surface clearly enough.
  useEffect(() => {
    setError(null);
  }, [profile?.name]);

  const params: PreviewParams = useMemo(() => {
    const p: PreviewParams = {
      text,
      profile: profile?.name,
      emotion,
      mode,
      language: language || undefined,
      speed: advanced.speed,
      duration_seconds: advanced.duration_seconds > 0 ? advanced.duration_seconds : undefined,
      num_step: advanced.num_step,
      guidance_scale: advanced.guidance_scale,
      denoise: advanced.denoise,
      auto_asr: advanced.auto_asr,
      audio_format: advanced.audio_format,
      sample_rate: advanced.sample_rate,
    };
    if (advanced.seed !== '') p.seed = advanced.seed;
    if (mode === 'design' || (mode === 'auto' && instruct.trim())) {
      p.instruct = instruct.trim() || undefined;
    } else if (instruct.trim()) {
      p.instruct = instruct.trim();
    }
    return p;
  }, [text, profile?.name, emotion, mode, language, instruct, advanced]);

  const generate = useCallback(async () => {
    if (!text.trim()) {
      setError(t('voiceStudio.cloneDesign.errors.missingText'));
      return;
    }
    if (mode === 'design' && !instruct.trim()) {
      setError(t('voiceStudio.cloneDesign.errors.designNeedsInstruct'));
      return;
    }
    setBusy(true);
    setError(null);
    if (result?.blobUrl) URL.revokeObjectURL(result.blobUrl);
    try {
      const res = await voiceStudioApi.synthesizePreview(params);
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [params, mode, instruct, text, t, result?.blobUrl]);

  const regenerateSameSeed = useCallback(async () => {
    if (result?.seedUsed === undefined) return;
    setBusy(true);
    setError(null);
    const seeded = { ...params, seed: result.seedUsed };
    if (result?.blobUrl) URL.revokeObjectURL(result.blobUrl);
    try {
      const res = await voiceStudioApi.synthesizePreview(seeded);
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [params, result?.seedUsed, result?.blobUrl]);

  const charCount = text.length;
  const estimatedSeconds = (charCount / 8).toFixed(1); // rough heuristic
  const isDesign = mode === 'design';

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-[var(--primary-color)]" />
        <h2 className="text-[0.9375rem] font-semibold">{t('voiceStudio.cloneDesign.synthTitle')}</h2>
      </div>

      {/* Text */}
      <div>
        <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">
          {t('voiceStudio.cloneDesign.textLabel')}
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={2000}
          className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.875rem] outline-none focus:border-[var(--primary-color)] resize-none"
          placeholder={t('voiceStudio.cloneDesign.textPlaceholder')}
        />
        <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">
          {charCount} chars · ~{estimatedSeconds}s
        </p>
      </div>

      {/* Mode + Emotion + Language */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
          {(['clone', 'design', 'auto'] as PreviewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-[0.75rem] font-medium rounded transition-all duration-150 border-none cursor-pointer ${
                mode === m
                  ? 'bg-[var(--primary-color)] text-white shadow-sm'
                  : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t(`voiceStudio.cloneDesign.mode.${m}`)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {EMOTIONS.map((e) => (
            <button
              key={e}
              onClick={() => setEmotion(e)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[0.6875rem] font-medium border cursor-pointer transition-colors ${
                emotion === e
                  ? 'bg-[var(--primary-subtle)] border-[var(--primary-color)] text-[var(--primary-color)]'
                  : 'bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={e}
            >
              <span className={`w-2 h-2 rounded-full ${EMOTION_COLORS[e] || 'bg-gray-400'}`} />
              {t(`voiceStudio.cloneDesign.emotion.${e}`)}
            </button>
          ))}
        </div>

        <LanguagePicker value={language} onChange={setLanguage} />
      </div>

      {/* Instruct */}
      <InstructPanel value={instruct} onChange={setInstruct} enabled={mode !== 'clone'} />

      {/* Advanced */}
      <AdvancedParamsPanel values={advanced} onChange={setAdvanced} />

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={generate}
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {busy
            ? t('voiceStudio.cloneDesign.generating')
            : t('voiceStudio.cloneDesign.generate')}
        </button>
        {result?.seedUsed !== undefined && (
          <button
            onClick={regenerateSameSeed}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.75rem] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('voiceStudio.cloneDesign.regenerateSameSeedHint')}
          >
            <RefreshCw size={12} />
            {t('voiceStudio.cloneDesign.regenerateSameSeed')}
          </button>
        )}
        {isDesign && !instruct.trim() && (
          <span className="text-[0.6875rem] text-[var(--warning-color)]">
            {t('voiceStudio.cloneDesign.errors.designNeedsInstruct')}
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}

      {/* Preview */}
      <WaveformPreview
        src={result?.blobUrl ?? null}
        footer={
          result
            ? `${result.durationSeconds.toFixed(2)}s · RTF ${result.rtf.toFixed(2)} · sr ${result.sampleRate}${
                result.seedUsed !== undefined ? ` · seed ${result.seedUsed}` : ''
              }`
            : undefined
        }
        downloadName={
          result
            ? `voicestudio-${profile?.name ?? 'auto'}-${emotion}-${
                result.seedUsed ?? Date.now()
              }.${advanced.audio_format}`
            : undefined
        }
      />
    </section>
  );
}
