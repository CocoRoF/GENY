/**
 * MicrophoneRecorderModal — minimal browser-MediaRecorder UI.
 *
 * Owned by `recordAudio()` in `@/lib/microphoneRecorder` — that helper
 * mounts the modal on demand into a portal at `document.body` and
 * unmounts it once the user finishes (or cancels) the recording.
 *
 * Behavior:
 *   - Requests `getUserMedia({audio:true})` on mount and starts the
 *     MediaRecorder immediately. Failure → ``onDone(null)``.
 *   - Two buttons: **Stop** resolves with the recorded `Blob`,
 *     **Cancel** (or Esc / backdrop click) resolves with `null`.
 *   - On unmount, every MediaStreamTrack is stopped so the browser's
 *     "mic in use" indicator goes away immediately.
 *
 * Codec preference: prefer `audio/webm;codecs=opus` (well-supported
 * across Chromium / Firefox / recent Safari), fall back to whatever
 * the browser picks if Opus is unavailable. Whisper-large-v3 on the
 * vLLM server side accepts both via librosa-backed decoding.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, Square, X } from 'lucide-react';

export interface MicrophoneRecorderModalProps {
  /** Called once with the recorded blob (Stop) or `null` (Cancel / error). */
  onDone: (blob: Blob | null) => void;
}

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const mime of PREFERRED_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // Some browsers throw on unsupported probes — keep iterating.
    }
  }
  return undefined;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function MicrophoneRecorderModal({
  onDone,
}: MicrophoneRecorderModalProps) {
  const [phase, setPhase] = useState<
    'requesting' | 'recording' | 'finalising' | 'error'
  >('requesting');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTsRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  // Guard against double-resolve when Stop + unmount race.
  const resolvedRef = useRef(false);

  const finish = useCallback(
    (blob: Blob | null) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onDone(blob);
    },
    [onDone],
  );

  const teardown = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* ignored */
      }
    }
    recorderRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignored */
        }
      });
    }
    streamRef.current = null;
    const audioCtx = audioCtxRef.current;
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => {});
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    teardown();
    finish(null);
  }, [teardown, finish]);

  const handleStop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) {
      handleCancel();
      return;
    }
    setPhase('finalising');
    // Stop will trigger the `onstop` handler we installed below, which
    // assembles the final blob and calls `finish(...)`.
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        handleCancel();
      }
    }
  }, [handleCancel]);

  // ── Recorder lifecycle (mount once, teardown on unmount) ───────────
  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === 'undefined'
      ) {
        setPhase('error');
        setErrorMessage('Microphone capture not supported in this browser');
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        if (!cancelled) {
          setPhase('error');
          setErrorMessage(
            e instanceof Error
              ? e.message
              : 'Microphone permission was denied',
          );
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      const mimeType = pickMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch (e) {
        setPhase('error');
        setErrorMessage(
          e instanceof Error
            ? e.message
            : 'Could not initialise MediaRecorder',
        );
        return;
      }
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onerror = () => {
        setPhase('error');
        setErrorMessage('MediaRecorder error');
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        // Tear down stream + analyser BEFORE the parent unmounts us.
        teardown();
        // Empty blobs almost always mean the user cancelled before any
        // chunk landed — surface that as null instead of a 0-byte upload.
        finish(blob.size > 0 ? blob : null);
      };

      try {
        recorder.start(1000); // emit a chunk per second
      } catch (e) {
        setPhase('error');
        setErrorMessage(
          e instanceof Error
            ? e.message
            : 'Could not start MediaRecorder',
        );
        return;
      }

      startTsRef.current = performance.now();
      tickRef.current = window.setInterval(() => {
        setElapsedMs(performance.now() - startTsRef.current);
      }, 200);

      try {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new AC();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        analyserRef.current = analyser;
        const buffer = new Uint8Array(analyser.fftSize);
        const loop = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteTimeDomainData(buffer);
          let peak = 0;
          for (let i = 0; i < buffer.length; i++) {
            const v = Math.abs(buffer[i] - 128) / 128;
            if (v > peak) peak = v;
          }
          setLevel(peak);
          rafRef.current = window.requestAnimationFrame(loop);
        };
        loop();
      } catch {
        // Analyser is non-essential — recording works without it.
      }

      setPhase('recording');
    };

    start();

    return () => {
      cancelled = true;
      teardown();
      // If the modal is unmounted without a Stop → treat as cancel.
      finish(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc / Enter shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter' && phase === 'recording') {
        e.preventDefault();
        handleStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, handleCancel, handleStop]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice recording"
      onClick={(e) => {
        // Backdrop click cancels — but only when the click lands on
        // the backdrop itself, not on the inner panel.
        if (e.target === e.currentTarget) handleCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9000,
      }}
    >
      <div
        style={{
          minWidth: 320,
          maxWidth: 'min(420px, 92vw)',
          background: 'var(--obs-bg, #1c1c1e)',
          color: 'var(--obs-text, #e5e5e7)',
          border: '1px solid var(--obs-border, #2c2c2e)',
          borderRadius: 12,
          padding: 22,
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <Mic
              size={18}
              color={phase === 'recording' ? '#ef4444' : '#9ca3af'}
            />
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {phase === 'requesting' && 'Requesting microphone…'}
              {phase === 'recording' && 'Recording'}
              {phase === 'finalising' && 'Finalising…'}
              {phase === 'error' && 'Microphone error'}
            </div>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Cancel recording"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--obs-text, #9ca3af)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {phase === 'error' && (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: '#ef4444',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: 8,
              padding: '8px 10px',
            }}
          >
            {errorMessage ?? 'Unknown microphone error'}
          </div>
        )}

        {(phase === 'recording' || phase === 'finalising') && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontVariantNumeric: 'tabular-nums',
                fontFamily:
                  'var(--font-jetbrains-mono, ui-monospace, monospace)',
                fontSize: 28,
                fontWeight: 600,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background:
                    phase === 'recording' ? '#ef4444' : '#9ca3af',
                  boxShadow:
                    phase === 'recording'
                      ? '0 0 0 4px rgba(239,68,68,0.18)'
                      : 'none',
                  animation:
                    phase === 'recording'
                      ? 'mic-pulse 1.2s ease-in-out infinite'
                      : undefined,
                }}
              />
              <span>{formatElapsed(elapsedMs)}</span>
            </div>
            <div
              aria-hidden
              style={{
                height: 6,
                borderRadius: 3,
                background: 'rgba(255,255,255,0.06)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, Math.round(level * 140))}%`,
                  background:
                    'linear-gradient(90deg,#22c55e 0%,#84cc16 60%,#ef4444 100%)',
                  transition: 'width 80ms linear',
                }}
              />
            </div>
          </>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            type="button"
            onClick={handleCancel}
            disabled={phase === 'finalising'}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 7,
              border: '1px solid var(--obs-border, #2c2c2e)',
              background: 'transparent',
              color: 'var(--obs-text, #d1d1d6)',
              cursor: phase === 'finalising' ? 'not-allowed' : 'pointer',
              opacity: phase === 'finalising' ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStop}
            disabled={phase !== 'recording'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 7,
              border: '1px solid #ef4444',
              background:
                phase === 'recording' ? '#ef4444' : 'rgba(239,68,68,0.2)',
              color: '#fff',
              cursor: phase === 'recording' ? 'pointer' : 'not-allowed',
              opacity: phase === 'recording' ? 1 : 0.6,
            }}
          >
            <Square size={14} />
            <span>Stop & Save</span>
          </button>
        </div>
      </div>

      <style>{`
        @keyframes mic-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50%      { transform: scale(1.25); opacity: 0.7; }
        }
      `}</style>
    </div>,
    document.body,
  );
}
