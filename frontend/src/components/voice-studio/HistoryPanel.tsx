'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Download, Loader2, Play, Pause, RefreshCw,
  RotateCcw, Save, Trash2,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type HistoryItem, type PreviewResult } from '@/lib/voiceStudioApi';

interface HistoryPanelProps {
  /**
   * Caller bumps this counter when a new synthesis succeeds — the panel
   * refetches automatically. Saves a manual round-trip per generate.
   */
  refreshKey: number;
  /**
   * Open the SaveAsRefModal pre-populated for this history row.
   * (The modal lives in the parent so the result of save-as-ref can
   * be reflected in the emotion-ref grid alongside.)
   */
  onSaveAsRef: (item: HistoryItem) => void;
}

/**
 * Recent synthesis rows from ``/api/voice-studio/synth/history``.
 * Capped to 20 server-side. Each row exposes play / replay / download
 * / save-as-ref / delete actions; play uses ``getHistoryAudioUrl`` so
 * we don't pull the whole list of blobs eagerly.
 */
export default function HistoryPanel({ refreshKey, onSaveAsRef }: HistoryPanelProps) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Replay state: when set, the parent gets the result via window event
  // so it can reuse its waveform panel. Simplest decoupling.
  const [replayResult, setReplayResult] = useState<PreviewResult | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const list = await voiceStudioApi.getHistory(signal);
      setItems(list);
      setError(null);
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial + refreshKey-driven fetch.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [open, refreshKey, load]);

  // Auto-open the panel the first time a synthesis lands.
  useEffect(() => {
    if (refreshKey > 0 && !open) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Single shared <audio> element to avoid clashing playbacks.
  const audioRef = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new Audio();
  }, []);

  useEffect(() => {
    return () => {
      audioRef?.pause();
      if (audioRef?.src?.startsWith('blob:')) URL.revokeObjectURL(audioRef.src);
    };
  }, [audioRef]);

  const togglePlay = useCallback(
    (id: string) => {
      if (!audioRef) return;
      if (playingId === id) {
        audioRef.pause();
        setPlayingId(null);
        return;
      }
      void (async () => {
        try {
          const objectUrl = await voiceStudioApi.fetchAuthedObjectUrl(
            voiceStudioApi.getHistoryAudioUrl(id),
          );
          if (audioRef.src?.startsWith('blob:')) URL.revokeObjectURL(audioRef.src);
          audioRef.src = objectUrl;
          await audioRef.play();
          audioRef.onended = () => setPlayingId(null);
          audioRef.onerror = () => setPlayingId(null);
          setPlayingId(id);
        } catch {
          setPlayingId(null);
        }
      })();
    },
    [audioRef, playingId],
  );

  const onDelete = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await voiceStudioApi.deleteHistory(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const onReplay = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const r = await voiceStudioApi.replayHistory(id);
      if (replayResult?.blobUrl) URL.revokeObjectURL(replayResult.blobUrl);
      setReplayResult(r);
      // Reuse the shared audio element to play the fresh result.
      if (audioRef) {
        audioRef.src = r.blobUrl;
        audioRef.play();
        setPlayingId(id);
        audioRef.onended = () => setPlayingId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [audioRef, replayResult?.blobUrl]);

  useEffect(() => {
    return () => {
      if (replayResult?.blobUrl) URL.revokeObjectURL(replayResult.blobUrl);
    };
  }, [replayResult?.blobUrl]);

  return (
    <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-[0.8125rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('voiceStudio.history.title')}
        <span className="ml-1 text-[var(--text-muted)]">
          {t('voiceStudio.history.count', { n: items.length })}
        </span>
        {open && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              load();
            }}
            disabled={loading}
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.6875rem] text-[var(--text-muted)] hover:text-[var(--primary-color)] bg-transparent border-none cursor-pointer transition-colors disabled:opacity-50"
            title={t('voiceStudio.history.refresh')}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
              {error}
            </div>
          )}
          {loading && items.length === 0 && (
            <p className="px-2 py-4 text-[0.8125rem] text-[var(--text-muted)] text-center">
              {t('voiceStudio.history.loading')}
            </p>
          )}
          {!loading && !error && items.length === 0 && (
            <p className="px-2 py-4 text-[0.8125rem] text-[var(--text-muted)] text-center">
              {t('voiceStudio.history.empty')}
            </p>
          )}
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li
                key={it.id}
                className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2"
              >
                <p className="text-[0.8125rem] truncate text-[var(--text-primary)]" title={it.text}>
                  {it.text}
                </p>
                <p className="mt-0.5 text-[0.6875rem] text-[var(--text-muted)] font-mono truncate">
                  {it.profile ?? '—'} · {it.mode ?? '—'}
                  {it.seed !== undefined && it.seed !== null ? ` · seed ${it.seed}` : ''}
                  {' · '}{it.duration_seconds.toFixed(2)}s
                  {' · RTF '}{it.rtf.toFixed(2)}
                  {' · '}{formatRelative(it.created_at, locale)}
                </p>
                <div className="flex items-center gap-1 mt-1.5">
                  <button
                    onClick={() => togglePlay(it.id)}
                    disabled={busyId === it.id}
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-all disabled:opacity-50"
                    title={playingId === it.id ? 'Pause' : 'Play'}
                  >
                    {playingId === it.id ? <Pause size={11} /> : <Play size={11} />}
                  </button>
                  <button
                    onClick={() => onReplay(it.id)}
                    disabled={busyId === it.id}
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-all disabled:opacity-50"
                    title={t('voiceStudio.history.replay')}
                  >
                    {busyId === it.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                  </button>
                  <a
                    href="#download"
                    onClick={(e) => {
                      e.preventDefault();
                      void voiceStudioApi.downloadAuthed(
                        voiceStudioApi.getHistoryAudioUrl(it.id),
                        `voicestudio-${it.id}.wav`,
                      );
                    }}
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] no-underline cursor-pointer transition-all"
                    title={t('voiceStudio.history.download')}
                  >
                    <Download size={11} />
                  </a>
                  <button
                    onClick={() => onSaveAsRef(it)}
                    disabled={busyId === it.id}
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-all disabled:opacity-50"
                    title={t('voiceStudio.history.saveAsRef')}
                  >
                    <Save size={11} />
                  </button>
                  <button
                    onClick={() => onDelete(it.id)}
                    disabled={busyId === it.id}
                    className="ml-auto flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--danger-color)] hover:border-[var(--danger-color)] cursor-pointer transition-all disabled:opacity-50"
                    title={t('voiceStudio.history.delete')}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function formatRelative(isoUtc: string, _locale: string): string {
  void _locale;
  const then = Date.parse(isoUtc);
  if (!Number.isFinite(then)) return isoUtc;
  const delta = Date.now() - then;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
