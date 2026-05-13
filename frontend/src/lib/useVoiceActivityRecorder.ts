/**
 * useVoiceActivityRecorder — continuous mic capture for VTuber STT mode.
 *
 * Listens to the user's microphone with a Web-Audio analyser, detects
 * speech vs silence on simple energy thresholds, and emits one
 * ``Blob`` per detected utterance through ``onUtterance``. Suitable
 * for the V2 "always-listening" VTuber STT toggle — no manual
 * Stop button required.
 *
 * Lifecycle:
 *   1. Hook is mounted (or ``enabled`` flips to true) → requests
 *      ``getUserMedia({audio:{echoCancellation, noiseSuppression}})``,
 *      starts a MediaRecorder, and runs the analyser loop.
 *   2. RMS energy above ``speechThreshold`` for at least
 *      ``speechSustainMs`` → we mark the start of an utterance.
 *   3. RMS energy below ``silenceThreshold`` for at least
 *      ``silenceTrailMs`` → we stop the recorder, emit the Blob,
 *      and immediately start a new one for the next utterance.
 *   4. Utterance length cap ``maxUtteranceMs`` forces a split.
 *   5. Tiny clips (< ``minUtteranceMs``) are dropped silently —
 *      kept-cough / clipped-noise floor.
 *   6. Hook unmounts (or ``enabled`` → false) → every track and the
 *      audio context are released. Browser "mic in use" indicator
 *      goes away the same tick.
 *
 * The thresholds default to values that work in a quiet desk
 * environment (Macbook built-in mic, average room noise ≈ –50dB).
 * Operators can override per session via the options bag.
 *
 * Echo / feedback prevention:
 *   - ``echoCancellation`` + ``noiseSuppression`` are turned on at
 *     the ``getUserMedia`` layer, which handles most TTS bleed-in.
 *   - When the consumer knows TTS is playing it can pass
 *     ``pauseWhileSpeaking=true`` and toggle ``isAgentSpeaking`` —
 *     the analyser will then suppress utterance detection for the
 *     duration of the playback.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceActivityPhase =
  | 'idle'        // hook disabled or not mounted
  | 'requesting'  // awaiting mic permission
  | 'listening'   // mic open, no speech detected yet
  | 'speaking'    // currently in an utterance
  | 'error';      // permission denied or hardware blip

export interface UseVoiceActivityRecorderOptions {
  /** Master enable. Flipping false releases all resources. */
  enabled: boolean;

  /** Fires once per detected utterance. Failure inside the callback
   *  is logged and skipped — never breaks the next utterance. */
  onUtterance: (blob: Blob, durationMs: number) => void | Promise<void>;

  /** When true, the VAD ignores audio while the consumer reports
   *  ``isAgentSpeaking=true``. Useful when TTS is playing through
   *  the same speakers the mic can hear. Defaults to ``true``. */
  pauseWhileSpeaking?: boolean;
  isAgentSpeaking?: boolean;

  /** RMS energy (0..1) that counts as speech. Default 0.04 —
   *  empirically detects normal-volume Korean / English conversation
   *  at ~50 cm from a built-in laptop mic. */
  speechThreshold?: number;
  /** RMS energy (0..1) below which we count silence. Default 0.018
   *  — a notch below ``speechThreshold`` so we don't flap. */
  silenceThreshold?: number;
  /** How long energy must stay above ``speechThreshold`` before we
   *  call it an utterance start. Default 120 ms. Filters single-frame
   *  clicks / handset bumps. */
  speechSustainMs?: number;
  /** How long energy must stay below ``silenceThreshold`` to end
   *  the utterance. Default 1200 ms. Matches the natural pause
   *  between sentences without cutting mid-clause. */
  silenceTrailMs?: number;
  /** Maximum length of one utterance before a forced split.
   *  Default 30 s. */
  maxUtteranceMs?: number;
  /** Minimum length to emit. Default 400 ms. */
  minUtteranceMs?: number;
}

export interface UseVoiceActivityRecorderState {
  phase: VoiceActivityPhase;
  error: string | null;
  /** Live RMS level (0..1) — useful for a UI meter. */
  level: number;
  /** Current utterance length in ms while ``phase === 'speaking'``,
   *  else 0. */
  utteranceMs: number;
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
      /* probe error — keep iterating */
    }
  }
  return undefined;
}

export function useVoiceActivityRecorder(
  opts: UseVoiceActivityRecorderOptions,
): UseVoiceActivityRecorderState {
  const {
    enabled,
    onUtterance,
    pauseWhileSpeaking = true,
    isAgentSpeaking = false,
    speechThreshold = 0.04,
    silenceThreshold = 0.018,
    speechSustainMs = 120,
    silenceTrailMs = 1200,
    maxUtteranceMs = 30000,
    minUtteranceMs = 400,
  } = opts;

  const [phase, setPhase] = useState<VoiceActivityPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [utteranceMs, setUtteranceMs] = useState(0);

  // Mutable refs hold everything we need to read from inside the
  // analyser loop without re-running the effect on every state tick.
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recorderMimeRef = useRef<string>('audio/webm');
  const speechSinceRef = useRef<number | null>(null);
  const silenceSinceRef = useRef<number | null>(null);
  const utteranceStartRef = useRef<number | null>(null);
  // Live mirror of the agent-speaking flag so the analyser loop reads
  // a fresh value each frame without us re-arming the loop.
  const muteRef = useRef(pauseWhileSpeaking && isAgentSpeaking);
  // Same mirror trick for the utterance callback so callers can pass
  // a fresh closure on each render without restarting the recorder.
  const onUtteranceRef = useRef(onUtterance);

  useEffect(() => {
    muteRef.current = pauseWhileSpeaking && isAgentSpeaking;
  }, [pauseWhileSpeaking, isAgentSpeaking]);

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  }, [onUtterance]);

  // ── Recorder lifecycle ─────────────────────────────────────────
  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* ignored */
      }
    }
    chunksRef.current = [];
    speechSinceRef.current = null;
    silenceSinceRef.current = null;
    utteranceStartRef.current = null;

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        /* ignored */
      }
      sourceNodeRef.current = null;
    }
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== 'closed') {
      ctx.close().catch(() => {});
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignored */
        }
      });
    }
    setLevel(0);
    setUtteranceMs(0);
  }, []);

  const startUtteranceRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (typeof MediaRecorder === 'undefined') return;
    const mime = recorderMimeRef.current;
    let recorder: MediaRecorder;
    try {
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    try {
      recorder.start(250);
    } catch {
      recorderRef.current = null;
    }
  }, []);

  const finishUtterance = useCallback(
    (reason: 'silence' | 'forced') => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      const startTs = utteranceStartRef.current;
      utteranceStartRef.current = null;
      speechSinceRef.current = null;
      silenceSinceRef.current = null;
      setUtteranceMs(0);

      const durationMs =
        startTs !== null ? Math.max(0, performance.now() - startTs) : 0;

      if (!recorder) return;
      const mime = recorderMimeRef.current;
      // Wait for any in-flight chunk to flush before we read them out.
      // ``onstop`` fires after the recorder has drained, so install
      // the handler then call stop().
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (durationMs < minUtteranceMs) {
          return; // too short — drop
        }
        if (!chunks.length) return;
        try {
          const blob = new Blob(chunks, { type: mime });
          if (blob.size > 0) {
            const cb = onUtteranceRef.current;
            const out = cb(blob, durationMs);
            if (out && typeof (out as Promise<void>).catch === 'function') {
              (out as Promise<void>).catch((err) => {
                // Callback failures stay quiet — next utterance still works.
                // eslint-disable-next-line no-console
                console.warn(
                  '[useVoiceActivityRecorder] onUtterance threw',
                  err,
                );
              });
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[useVoiceActivityRecorder] blob build failed', err);
        }
        // Suppress unused warning when reason is logged in future
        // debug builds; keeping for symmetry with the forced path.
        void reason;
      };
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* ignored */
        }
      }
    },
    [minUtteranceMs],
  );

  useEffect(() => {
    if (!enabled) {
      teardown();
      setPhase('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);
    setPhase('requesting');

    const start = async () => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === 'undefined' ||
        typeof window === 'undefined'
      ) {
        setPhase('error');
        setError('Microphone capture not supported in this browser');
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          } as MediaTrackConstraints,
        });
      } catch (e) {
        if (cancelled) return;
        setPhase('error');
        setError(
          e instanceof Error
            ? e.message
            : 'Microphone permission denied',
        );
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mime = pickMimeType();
      if (mime) recorderMimeRef.current = mime;

      try {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new AC();
        audioCtxRef.current = audioCtx;
        const sourceNode = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        sourceNode.connect(analyser);
        sourceNodeRef.current = sourceNode;
        analyserRef.current = analyser;
      } catch (e) {
        if (cancelled) {
          teardown();
          return;
        }
        setPhase('error');
        setError(
          e instanceof Error ? e.message : 'AudioContext setup failed',
        );
        teardown();
        return;
      }

      setPhase('listening');

      const buffer = new Uint8Array(analyserRef.current!.fftSize);
      const loop = () => {
        const analyser = analyserRef.current;
        if (!analyser) return;
        analyser.getByteTimeDomainData(buffer);
        // RMS energy estimate, normalised to 0..1.
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);
        setLevel(rms);

        const now = performance.now();
        const isMuted = muteRef.current;

        if (isMuted) {
          // Force a clean reset of the VAD machine while muted so a
          // half-detected utterance doesn't drag past the mute window.
          speechSinceRef.current = null;
          silenceSinceRef.current = null;
          if (utteranceStartRef.current !== null) {
            finishUtterance('forced');
          }
          rafRef.current = window.requestAnimationFrame(loop);
          return;
        }

        if (rms >= speechThreshold) {
          if (speechSinceRef.current === null) speechSinceRef.current = now;
          silenceSinceRef.current = null;
        } else if (rms <= silenceThreshold) {
          if (silenceSinceRef.current === null) silenceSinceRef.current = now;
          speechSinceRef.current = null;
        } else {
          // In the hysteresis band — hold state.
        }

        if (utteranceStartRef.current === null) {
          // Not yet recording. Start when speech sustains.
          if (
            speechSinceRef.current !== null &&
            now - speechSinceRef.current >= speechSustainMs
          ) {
            utteranceStartRef.current = now;
            setPhase('speaking');
            startUtteranceRecording();
          }
        } else {
          // Recording. Stop on sustained silence OR forced max length.
          const elapsed = now - utteranceStartRef.current;
          setUtteranceMs(elapsed);
          if (
            silenceSinceRef.current !== null &&
            now - silenceSinceRef.current >= silenceTrailMs
          ) {
            finishUtterance('silence');
            setPhase('listening');
          } else if (elapsed >= maxUtteranceMs) {
            finishUtterance('forced');
            setPhase('listening');
          }
        }

        rafRef.current = window.requestAnimationFrame(loop);
      };
      loop();
    };

    start();

    return () => {
      cancelled = true;
      teardown();
    };
    // The thresholds + sustain windows are stable strings/numbers
    // from the caller's render; restart-on-change is acceptable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    teardown,
    finishUtterance,
    startUtteranceRecording,
    speechThreshold,
    silenceThreshold,
    speechSustainMs,
    silenceTrailMs,
    maxUtteranceMs,
  ]);

  return { phase, error, level, utteranceMs };
}
