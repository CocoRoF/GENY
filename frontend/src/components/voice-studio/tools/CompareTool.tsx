'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles, Trash2, Plus, GitCompare } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import {
  voiceStudioApi,
  type PreviewMode,
  type PreviewResult,
} from '@/lib/voiceStudioApi';
import ToolCard from './ToolCard';
import WaveformPreview from '@/components/voice-studio/WaveformPreview';

interface Variant {
  label: string;
  mode: PreviewMode;
  seed: number | '';
  num_step: number | '';
  result?: PreviewResult;
  error?: string;
}

const MAX_VARIANTS = 5;

function makeVariant(idx: number): Variant {
  return {
    label: `V${idx}`,
    mode: 'clone',
    seed: Math.floor(Math.random() * 1_000_000),
    num_step: '',
  };
}

export default function CompareTool() {
  const { t } = useI18n();
  const [text, setText] = useState('안녕하세요. 오늘은 날씨가 좋네요.');
  const [profile, setProfile] = useState<string>('');
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [variants, setVariants] = useState<Variant[]>([makeVariant(1), makeVariant(2)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ttsApi
      .listProfiles()
      .then((res) => {
        const list = res.profiles || [];
        setProfiles(list);
        const active = list.find((p) => p.active);
        setProfile((prev) => prev || (active || list[0])?.name || '');
      })
      .catch(() => {/* surfaces below */});
  }, []);

  const patch = (idx: number, delta: Partial<Variant>) => {
    setVariants((prev) => prev.map((v, i) => (i === idx ? { ...v, ...delta } : v)));
  };

  const addVariant = () =>
    setVariants((prev) => (prev.length >= MAX_VARIANTS ? prev : [...prev, makeVariant(prev.length + 1)]));

  const removeVariant = (idx: number) =>
    setVariants((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));

  const generateAll = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);

    // Revoke any old blob URLs first.
    variants.forEach((v) => {
      if (v.result?.blobUrl) URL.revokeObjectURL(v.result.blobUrl);
    });

    const next = variants.map((v) => ({ ...v, result: undefined, error: undefined }));
    setVariants(next);

    const settled = await Promise.allSettled(
      variants.map((v) =>
        voiceStudioApi.synthesizePreview({
          text,
          profile: profile || undefined,
          mode: v.mode,
          seed: v.seed === '' ? undefined : v.seed,
          num_step: v.num_step === '' ? undefined : v.num_step,
          audio_format: 'wav',
        }),
      ),
    );

    setVariants((prev) =>
      prev.map((v, i) => {
        const s = settled[i];
        if (s.status === 'fulfilled') {
          return { ...v, result: s.value, error: undefined };
        }
        return { ...v, error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
      }),
    );
    setBusy(false);
  }, [text, profile, variants]);

  useEffect(() => {
    return () => {
      variants.forEach((v) => {
        if (v.result?.blobUrl) URL.revokeObjectURL(v.result.blobUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ToolCard
      icon={<GitCompare size={14} className="text-[var(--primary-color)]" />}
      title={t('voiceStudio.tools.compare.title')}
      hint={t('voiceStudio.tools.compare.hint')}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder={t('voiceStudio.cloneDesign.textPlaceholder')}
        className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.8125rem] outline-none focus:border-[var(--primary-color)] resize-none"
      />

      <div className="flex items-center gap-2 mt-2">
        <span className="text-[0.6875rem] text-[var(--text-muted)]">{t('voiceStudio.cloneDesign.profile')}</span>
        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          className="px-2 py-1 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.75rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
        >
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>{p.display_name || p.name}{p.active ? ' ★' : ''}</option>
          ))}
        </select>
      </div>

      <div className="mt-3 space-y-2">
        {variants.map((v, i) => (
          <div key={i} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-2">
            <div className="flex items-center gap-2 flex-wrap text-[0.75rem]">
              <span className="text-[var(--text-secondary)] font-medium w-7">{v.label}</span>
              <select
                value={v.mode}
                onChange={(e) => patch(i, { mode: e.target.value as PreviewMode })}
                className="px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
              >
                <option value="clone">clone</option>
                <option value="design">design</option>
                <option value="auto">auto</option>
              </select>
              <label className="text-[var(--text-muted)]">seed</label>
              <input
                type="number"
                min={0}
                value={v.seed}
                onChange={(e) => patch(i, { seed: e.target.value === '' ? '' : parseInt(e.target.value, 10) || 0 })}
                className="w-24 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] font-mono"
              />
              <label className="text-[var(--text-muted)]">num_step</label>
              <input
                type="number"
                min={1}
                max={128}
                placeholder="default"
                value={v.num_step}
                onChange={(e) => patch(i, { num_step: e.target.value === '' ? '' : parseInt(e.target.value, 10) || '' })}
                className="w-20 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] font-mono"
              />
              <button
                onClick={() => removeVariant(i)}
                disabled={variants.length <= 1}
                className="ml-auto flex items-center justify-center w-6 h-6 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--danger-color)] cursor-pointer transition-colors disabled:opacity-30"
                title={t('voiceStudio.tools.compare.removeVariant')}
              >
                <Trash2 size={11} />
              </button>
            </div>
            {v.error && (
              <p className="mt-1 text-[0.6875rem] text-[var(--danger-color)]">{v.error}</p>
            )}
            {v.result && (
              <div className="mt-2">
                <WaveformPreview
                  src={v.result.blobUrl}
                  footer={`${v.result.durationSeconds.toFixed(2)}s · RTF ${v.result.rtf.toFixed(2)} · seed ${v.result.seedUsed ?? '?'}`}
                  downloadName={`compare-${v.label}-seed${v.result.seedUsed ?? 'x'}.wav`}
                />
              </div>
            )}
          </div>
        ))}
        <button
          onClick={addVariant}
          disabled={variants.length >= MAX_VARIANTS}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.75rem] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          {t('voiceStudio.tools.compare.addVariant')}
        </button>
      </div>

      {error && (
        <div className="mt-2 px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}

      <div className="mt-3">
        <button
          onClick={generateAll}
          disabled={busy || !text.trim() || !profile}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {busy ? t('voiceStudio.tools.compare.generating') : t('voiceStudio.tools.compare.generateAll')}
        </button>
      </div>
    </ToolCard>
  );
}
