'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Search, Play, Pause, Download } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { voiceStudioApi, type SeedSearchResult } from '@/lib/voiceStudioApi';
import ToolCard from './ToolCard';

const EMOTIONS = ['neutral', 'joy', 'anger', 'sadness', 'fear', 'surprise', 'disgust', 'smirk'] as const;

export default function SeedSearchTool() {
  const { t } = useI18n();
  const [text, setText] = useState('안녕하세요.');
  const [profile, setProfile] = useState<string>('');
  const [emotion, setEmotion] = useState<string>('neutral');
  const [n, setN] = useState(5);
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SeedSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingSeed, setPlayingSeed] = useState<number | null>(null);

  useEffect(() => {
    ttsApi.listProfiles().then((res) => {
      const list = res.profiles || [];
      setProfiles(list);
      const active = list.find((p) => p.active);
      setProfile((prev) => prev || (active || list[0])?.name || '');
    }).catch(() => {});
  }, []);

  const audioRef = useState<HTMLAudioElement | null>(() => {
    if (typeof window === 'undefined') return null;
    return new Audio();
  })[0];

  useEffect(() => {
    return () => {
      audioRef?.pause();
    };
  }, [audioRef]);

  const togglePlay = useCallback((url: string, seed: number) => {
    if (!audioRef) return;
    if (playingSeed === seed) {
      audioRef.pause();
      setPlayingSeed(null);
      return;
    }
    audioRef.src = url;
    audioRef.play();
    setPlayingSeed(seed);
    audioRef.onended = () => setPlayingSeed(null);
    audioRef.onerror = () => setPlayingSeed(null);
  }, [audioRef, playingSeed]);

  const run = useCallback(async () => {
    if (!text.trim() || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const r = await voiceStudioApi.seedSearch({
        text, profile, emotion, n,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [text, profile, emotion, n]);

  return (
    <ToolCard
      icon={<Search size={14} className="text-[var(--primary-color)]" />}
      title={t('voiceStudio.tools.seedSearch.title')}
      hint={t('voiceStudio.tools.seedSearch.hint')}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.8125rem] outline-none focus:border-[var(--primary-color)] resize-none"
      />

      <div className="flex items-center flex-wrap gap-2 mt-2 text-[0.75rem]">
        <span className="text-[var(--text-muted)]">{t('voiceStudio.cloneDesign.profile')}</span>
        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          className="px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
        >
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>{p.display_name || p.name}{p.active ? ' ★' : ''}</option>
          ))}
        </select>

        <span className="text-[var(--text-muted)] ml-2">{t('voiceStudio.tools.seedSearch.emotion')}</span>
        <select
          value={emotion}
          onChange={(e) => setEmotion(e.target.value)}
          className="px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
        >
          {EMOTIONS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>

        <span className="text-[var(--text-muted)] ml-2">N</span>
        <input
          type="number"
          min={1}
          max={10}
          value={n}
          onChange={(e) => setN(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
          className="w-16 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-mono"
        />

        <button
          onClick={run}
          disabled={busy || !text.trim() || !profile}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.75rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          {busy ? t('voiceStudio.tools.seedSearch.running') : t('voiceStudio.tools.seedSearch.run')}
        </button>
      </div>

      {error && (
        <div className="mt-2 px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[0.6875rem] text-[var(--text-muted)] font-mono">
            batch_id={result.batch_id} · n={result.n}
          </p>
          {result.results.map((r) => (
            <div key={r.seed} className="rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 flex items-center gap-2 text-[0.75rem]">
              <span className="font-mono text-[var(--text-secondary)] w-28 shrink-0">seed {r.seed}</span>
              {r.error ? (
                <span className="text-[var(--danger-color)] flex-1 truncate">{r.error}</span>
              ) : (
                <>
                  <button
                    onClick={() => r.audio_url && togglePlay(r.audio_url, r.seed)}
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-all"
                    title={playingSeed === r.seed ? 'Pause' : 'Play'}
                  >
                    {playingSeed === r.seed ? <Pause size={11} /> : <Play size={11} />}
                  </button>
                  {r.audio_url && (
                    <a
                      href={r.audio_url}
                      download={`seed-${r.seed}.wav`}
                      className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] no-underline cursor-pointer transition-all"
                      title="Download"
                    >
                      <Download size={11} />
                    </a>
                  )}
                  <span className="text-[var(--text-muted)] ml-auto font-mono">
                    {r.duration?.toFixed(2)}s · RTF {r.rtf?.toFixed(2)}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
}
