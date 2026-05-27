'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Check, Loader2, Play, Pause } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { blobToWav } from '@/lib/audioUtils';

const RECOMMENDED_MIN_S = 5;
const RECOMMENDED_MAX_S = 15;
const HARD_MIN_S = 1;
const HARD_MAX_S = 60;

interface TrimmerModalProps {
  open: boolean;
  /** Source audio. Any decodable format (wav/webm/ogg/mp3). */
  source: Blob | null;
  onClose: () => void;
  onConfirm: (wav: Blob, durationSec: number) => void;
}

/**
 * Waveform-based trimming modal. wavesurfer.js + the regions plugin
 * show a draggable [start, end] region; on confirm we re-encode the
 * selection through ``blobToWav`` to mono 16-bit PCM @ 24 kHz.
 *
 * wavesurfer is imported lazily inside ``useEffect`` to avoid touching
 * ``window`` during SSR.
 */
export default function TrimmerModal({ open, source, onClose, onConfirm }: TrimmerModalProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const regionRef = useRef<any>(null);

  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [region, setRegion] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manage object URL lifecycle for the source blob.
  useEffect(() => {
    if (!open || !source) {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      setSourceUrl(null);
      return;
    }
    const url = URL.createObjectURL(source);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  // Mount wavesurfer + regions plugin when modal opens with a source.
  useEffect(() => {
    if (!open || !sourceUrl || !containerRef.current) return;
    let disposed = false;
    setReady(false);
    setPlaying(false);
    setError(null);

    (async () => {
      try {
        const WaveSurfer = (await import('wavesurfer.js')).default;
        const RegionsPlugin = (await import('wavesurfer.js/dist/plugins/regions.esm.js')).default;
        if (disposed || !containerRef.current) return;
        const regions = RegionsPlugin.create();
        const ws = WaveSurfer.create({
          container: containerRef.current,
          height: 96,
          waveColor: 'rgba(148, 163, 184, 0.55)',
          progressColor: 'var(--primary-color)',
          cursorColor: 'var(--primary-color)',
          barWidth: 2,
          barGap: 2,
          barRadius: 1,
          normalize: true,
          plugins: [regions],
          url: sourceUrl,
        });
        wsRef.current = ws;

        ws.on('ready', () => {
          if (disposed) return;
          const dur = ws.getDuration();
          setDuration(dur);
          const end = Math.min(dur, RECOMMENDED_MAX_S);
          const r = regions.addRegion({
            start: 0,
            end,
            color: 'rgba(59, 130, 246, 0.18)',
            drag: true,
            resize: true,
          });
          regionRef.current = r;
          setRegion({ start: 0, end });
          r.on('update', () => {
            setRegion({ start: r.start, end: r.end });
          });
          r.on('update-end', () => {
            setRegion({ start: r.start, end: r.end });
          });
          setReady(true);
        });
        ws.on('play', () => setPlaying(true));
        ws.on('pause', () => setPlaying(false));
        ws.on('finish', () => setPlaying(false));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      disposed = true;
      try {
        regionRef.current?.remove();
      } catch {
        /* ignore */
      }
      regionRef.current = null;
      try {
        wsRef.current?.destroy();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
  }, [open, sourceUrl]);

  const togglePlay = useCallback(() => {
    const ws = wsRef.current;
    const r = regionRef.current;
    if (!ws || !r) return;
    if (ws.isPlaying()) {
      ws.pause();
      return;
    }
    // Play just the region.
    ws.setTime(r.start);
    const stopAt = r.end;
    const tick = () => {
      if (!wsRef.current) return;
      if (wsRef.current.getCurrentTime() >= stopAt) {
        wsRef.current.pause();
        wsRef.current.un('timeupdate', tick);
      }
    };
    ws.on('timeupdate', tick);
    ws.play();
  }, []);

  const confirm = useCallback(async () => {
    if (!source) return;
    const { start, end } = region;
    const sliceLen = end - start;
    if (sliceLen < HARD_MIN_S) {
      setError(t('voiceStudio.trimmer.tooShort'));
      return;
    }
    if (sliceLen > HARD_MAX_S) {
      setError(t('voiceStudio.trimmer.tooLong'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const wav = await blobToWav(source, {
        startSec: start,
        endSec: end,
        targetSampleRate: 24000,
      });
      onConfirm(wav, sliceLen);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [source, region, t, onConfirm, onClose]);

  if (!open) return null;

  const sliceLen = Math.max(0, region.end - region.start);
  const inRecommended = sliceLen >= RECOMMENDED_MIN_S && sliceLen <= RECOMMENDED_MAX_S;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-2xl rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[0.9375rem] font-semibold">{t('voiceStudio.trimmer.title')}</h3>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-5 space-y-3">
          <p className="text-[0.75rem] text-[var(--text-muted)]">{t('voiceStudio.trimmer.hint')}</p>

          {!ready && !error && (
            <div className="flex items-center justify-center py-10 text-[var(--text-muted)] gap-2 text-[0.8125rem]">
              <Loader2 size={14} className="animate-spin" />
              {t('voiceStudio.trimmer.loading')}
            </div>
          )}
          {error && (
            <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
              {error}
            </div>
          )}
          <div ref={containerRef} className={`w-full ${ready ? '' : 'opacity-0 h-0'}`} />

          {ready && (
            <div className="flex items-center gap-3 text-[0.75rem] font-mono">
              <button
                onClick={togglePlay}
                className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors"
              >
                {playing ? <Pause size={12} /> : <Play size={12} />}
              </button>
              <span className="text-[var(--text-secondary)]">
                {region.start.toFixed(2)}s — {region.end.toFixed(2)}s
              </span>
              <span className={inRecommended ? 'text-[var(--success-color)]' : 'text-[var(--warning-color)]'}>
                {t('voiceStudio.trimmer.regionHint', { sec: sliceLen.toFixed(2) })}
              </span>
              <span className="ml-auto text-[var(--text-muted)]">
                {t('voiceStudio.trimmer.totalDuration', { sec: duration.toFixed(2) })}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-color)]">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--text-primary)] cursor-pointer transition-colors disabled:opacity-50"
          >
            {t('voiceStudio.trimmer.cancel')}
          </button>
          <button
            onClick={confirm}
            disabled={busy || !ready}
            className="ml-auto inline-flex items-center gap-1 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t('voiceStudio.trimmer.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
