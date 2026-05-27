'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, X, Check, RotateCcw, Loader2, Scissors } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { blobToWav, pickMediaRecorderMime } from '@/lib/audioUtils';

const MAX_RECORD_SECONDS = 60;

interface RecorderModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called with the trimmed-or-raw WAV blob when the user confirms.
   * Caller is responsible for the actual upload to the backend.
   */
  onConfirm: (wav: Blob, durationSec: number) => void;
  /**
   * When true, pressing "Confirm" also fires ``onRequestTrim`` instead of
   * the regular ``onConfirm`` so the caller can chain a TrimmerModal.
   */
  onRequestTrim?: (rawWav: Blob, durationSec: number) => void;
}

type Phase =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'encoding'
  | 'ready'
  | 'error';

/**
 * In-page microphone recorder. Captures audio via ``MediaRecorder`` at
 * the browser's default sample rate, then transcodes through
 * ``blobToWav`` to mono 16-bit PCM @ 24 kHz so the upload payload is
 * directly compatible with the reference-audio uploader.
 */
export default function RecorderModal({ open, onClose, onConfirm, onRequestTrim }: RecorderModalProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [wav, setWav] = useState<Blob | null>(null);
  const [wavUrl, setWavUrl] = useState<string | null>(null);
  const [wavDuration, setWavDuration] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  // Cleanup on close / unmount.
  const fullCleanup = useCallback(() => {
    if (tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    try {
      recorderRef.current?.state === 'recording' && recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    if (!open) {
      fullCleanup();
      if (wavUrl) URL.revokeObjectURL(wavUrl);
      setWav(null);
      setWavUrl(null);
      setWavDuration(0);
      setSeconds(0);
      setError(null);
      setPhase('idle');
      return;
    }
    // Eagerly check secure-context + MediaRecorder support.
    if (typeof window === 'undefined') return;
    if (!window.isSecureContext) {
      setError(t('voiceStudio.recorder.nonSecure'));
      setPhase('error');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(t('voiceStudio.recorder.unsupported'));
      setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Revoke previous preview URL when wav changes.
  useEffect(() => {
    return () => {
      if (wavUrl) URL.revokeObjectURL(wavUrl);
    };
  }, [wavUrl]);

  const startRecording = useCallback(async () => {
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const mime = pickMediaRecorderMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const raw = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
        chunksRef.current = [];
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        if (tickerRef.current) {
          clearInterval(tickerRef.current);
          tickerRef.current = null;
        }
        setPhase('encoding');
        try {
          const out = await blobToWav(raw, { targetSampleRate: 24000 });
          const url = URL.createObjectURL(out);
          // Probe duration via <audio>; fallback to elapsed seconds.
          const probed = await probeDuration(url).catch(() => seconds);
          setWav(out);
          setWavUrl(url);
          setWavDuration(probed);
          setPhase('ready');
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
        }
      };

      recorder.start(250);
      startedAtRef.current = performance.now();
      setSeconds(0);
      tickerRef.current = setInterval(() => {
        const elapsed = (performance.now() - startedAtRef.current) / 1000;
        setSeconds(elapsed);
        if (elapsed >= MAX_RECORD_SECONDS) {
          try {
            recorder.stop();
          } catch {
            /* ignore */
          }
        }
      }, 100);
      setPhase('recording');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /denied|notallowed|permission/i.test(msg)
          ? t('voiceStudio.recorder.permissionDenied')
          : msg,
      );
      setPhase('error');
    }
  }, [t, seconds]);

  const stopRecording = useCallback(() => {
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, []);

  const retry = useCallback(() => {
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    setWav(null);
    setWavUrl(null);
    setWavDuration(0);
    setSeconds(0);
    setError(null);
    setPhase('idle');
  }, [wavUrl]);

  const confirm = useCallback(() => {
    if (!wav) return;
    onConfirm(wav, wavDuration);
    onClose();
  }, [wav, wavDuration, onConfirm, onClose]);

  const trim = useCallback(() => {
    if (!wav || !onRequestTrim) return;
    onRequestTrim(wav, wavDuration);
    // Caller closes us (or we close here — but the parent typically wants
    // to keep the modal sequence visible until trim is confirmed).
    onClose();
  }, [wav, wavDuration, onRequestTrim, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[0.9375rem] font-semibold">{t('voiceStudio.recorder.title')}</h3>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-5 space-y-4">
          {phase === 'error' && (
            <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
              {error}
            </div>
          )}

          <div className="flex flex-col items-center gap-2 py-4">
            {phase === 'idle' || phase === 'requesting' || phase === 'error' ? (
              <button
                onClick={startRecording}
                disabled={phase === 'requesting' || phase === 'error'}
                className="flex items-center justify-center w-20 h-20 rounded-full bg-[var(--primary-color)] text-white border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
                title={t('voiceStudio.recorder.start')}
              >
                {phase === 'requesting' ? (
                  <Loader2 size={28} className="animate-spin" />
                ) : (
                  <Mic size={28} />
                )}
              </button>
            ) : phase === 'recording' ? (
              <button
                onClick={stopRecording}
                className="flex items-center justify-center w-20 h-20 rounded-full bg-[var(--danger-color)] text-white border-none cursor-pointer hover:opacity-90 transition-opacity shadow-md animate-pulse"
                title={t('voiceStudio.recorder.stop')}
              >
                <Square size={24} fill="currentColor" />
              </button>
            ) : phase === 'encoding' ? (
              <div className="flex items-center justify-center w-20 h-20 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-color)]">
                <Loader2 size={28} className="animate-spin" />
              </div>
            ) : (
              <div className="flex items-center justify-center w-20 h-20 rounded-full bg-[rgba(34,197,94,0.15)] text-[var(--success-color)] border border-[rgba(34,197,94,0.3)]">
                <Check size={28} />
              </div>
            )}
            <span className="text-[1.125rem] font-mono text-[var(--text-secondary)]">
              {formatSeconds(phase === 'ready' ? wavDuration : seconds)}
            </span>
            {phase === 'recording' && (
              <p className="text-[0.6875rem] text-[var(--text-muted)]">
                {t('voiceStudio.recorder.maxHint', { sec: MAX_RECORD_SECONDS })}
              </p>
            )}
            {phase === 'idle' && (
              <p className="text-[0.6875rem] text-[var(--text-muted)] text-center max-w-xs">
                {t('voiceStudio.recorder.hint')}
              </p>
            )}
          </div>

          {/* Preview */}
          {phase === 'ready' && wavUrl && (
            <audio src={wavUrl} controls className="w-full" />
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-color)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
          >
            {t('voiceStudio.recorder.cancel')}
          </button>
          {phase === 'ready' && (
            <>
              <button
                onClick={retry}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors"
              >
                <RotateCcw size={12} />
                {t('voiceStudio.recorder.retry')}
              </button>
              {onRequestTrim && (
                <button
                  onClick={trim}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors"
                >
                  <Scissors size={12} />
                  {t('voiceStudio.recorder.trimNext')}
                </button>
              )}
              <button
                onClick={confirm}
                className="ml-auto inline-flex items-center gap-1 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity"
              >
                <Check size={12} />
                {t('voiceStudio.recorder.confirm')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(1, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

async function probeDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const d = audio.duration;
      resolve(Number.isFinite(d) ? d : 0);
    };
    audio.onerror = () => reject(new Error('probe error'));
    audio.src = url;
  });
}
