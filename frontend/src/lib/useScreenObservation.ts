/**
 * useScreenObservation — V3 proactive screen-observation lifecycle.
 *
 * When the consumer toggles ``enabled`` on, the hook:
 *
 *   1. Calls ``getDisplayMedia`` ONCE so the user picks the screen /
 *      window / tab to share and grants permission. The MediaStream
 *      stays alive for the whole "ON" period so subsequent captures
 *      don't keep re-prompting.
 *
 *   2. Captures a frame immediately and uploads it via
 *      ``vtuberApi.uploadScreenObservation`` (with ``sessionId``).
 *
 *   3. Sets a ``setInterval`` (default 3 min, configurable) that
 *      repeats the capture-and-upload step on every tick.
 *
 *   4. Listens for the user manually ending the share via the
 *      browser's stop button (the ``track.onended`` callback); when
 *      that fires the hook auto-flips ``enabled`` to false so the
 *      consumer's UI updates.
 *
 *   5. Exposes a ``captureNow()`` callback the consumer wires to a
 *      "Show Now" button. Uploads with ``forceTrigger=true`` so the
 *      backend cooldown is bypassed.
 *
 *   6. On ``enabled = false`` (toggle off, component unmount,
 *      stream ended), stops every track and clears the interval.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { vtuberApi } from '@/lib/api';

export type ScreenObservationPhase =
  | 'idle'          // disabled
  | 'requesting'    // awaiting getDisplayMedia permission
  | 'observing'     // stream live, waiting on next tick
  | 'capturing'     // mid-frame capture + upload
  | 'error';

export interface UseScreenObservationOptions {
  enabled: boolean;
  sessionId: string | null | undefined;
  /** Interval between automatic captures, in milliseconds. Default
   *  3 minutes. Set higher for less-frequent observation, lower
   *  (e.g. 60s for debugging) to test the trigger pipeline. */
  intervalMs?: number;
  /** Called when the hook flips itself off — e.g. the user clicked
   *  the browser's "Stop sharing" button — so the consumer can
   *  reconcile its toggle state. */
  onAutoDisable?: () => void;
  /** Optional toast hook for surfacing per-upload outcomes. The
   *  hook calls it with ``{ trigger_fired, caption, skipped_reason }``
   *  on every successful upload. */
  onUploadResult?: (result: {
    trigger_fired: boolean;
    caption: string;
    skipped_reason: string | null;
  }) => void;
}

export interface UseScreenObservationState {
  phase: ScreenObservationPhase;
  error: string | null;
  lastCapturedAt: number | null;
  lastTriggerFired: boolean | null;
  uploadsInFlight: number;
  /** Force an immediate upload with ``forceTrigger=true``. No-op
   *  when the stream isn't live yet. */
  captureNow: () => void;
}


/** Pull a single frame from a live ``MediaStream`` as a PNG ``Blob``.
 *  Mirrors the existing ``screen_capture`` source's helper but
 *  doesn't release the stream — the caller owns the stream lifetime. */
async function _captureFrameAsBlob(
  stream: MediaStream,
): Promise<Blob | null> {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    return null;
  }

  // One animation frame ensures compositing has happened so we
  // don't grab a black frame on some browsers.
  await new Promise((r) => requestAnimationFrame(r));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob((blob) => resolve(blob), 'image/png', 0.92),
  );
}


export function useScreenObservation(
  opts: UseScreenObservationOptions,
): UseScreenObservationState {
  const {
    enabled,
    sessionId,
    intervalMs = 180_000,  // 3 min
    onAutoDisable,
    onUploadResult,
  } = opts;

  const [phase, setPhase] = useState<ScreenObservationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastCapturedAt, setLastCapturedAt] = useState<number | null>(null);
  const [lastTriggerFired, setLastTriggerFired] = useState<boolean | null>(null);
  const [uploadsInFlight, setUploadsInFlight] = useState(0);

  // Mutable refs hold lifecycle state so the global tick / track-end
  // handlers can read fresh values without re-arming the effect.
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string | null | undefined>(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const onAutoDisableRef = useRef(onAutoDisable);
  useEffect(() => {
    onAutoDisableRef.current = onAutoDisable;
  }, [onAutoDisable]);
  const onUploadResultRef = useRef(onUploadResult);
  useEffect(() => {
    onUploadResultRef.current = onUploadResult;
  }, [onUploadResult]);

  const doUpload = useCallback(
    async (force: boolean) => {
      const stream = streamRef.current;
      const sid = sessionIdRef.current;
      if (!stream || !sid) return;
      setPhase('capturing');
      setUploadsInFlight((n) => n + 1);
      try {
        const blob = await _captureFrameAsBlob(stream);
        if (!blob) {
          setError('frame capture failed');
          setPhase('observing');
          return;
        }
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-');
        const res = await vtuberApi.uploadScreenObservation({
          sessionId: sid,
          blob,
          filename: `screen-${stamp}.png`,
          forceTrigger: force,
        });
        setLastCapturedAt(Date.now());
        setLastTriggerFired(Boolean(res.trigger_fired));
        setError(null);
        onUploadResultRef.current?.({
          trigger_fired: Boolean(res.trigger_fired),
          caption: res.caption ?? '',
          skipped_reason: res.skipped_reason ?? null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[useScreenObservation] upload failed', msg);
        setError(msg);
      } finally {
        setUploadsInFlight((n) => Math.max(0, n - 1));
        setPhase('observing');
      }
    },
    [],
  );

  const captureNow = useCallback(() => {
    if (!streamRef.current) return;
    void doUpload(true);
  }, [doUpload]);

  const teardown = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
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
    setPhase('idle');
    setError(null);
    setLastTriggerFired(null);
  }, []);

  // ── Lifecycle effect ─────────────────────────────────────────────
  // ``enabled = false`` returns without setup; cleanup of the
  // previously-mounted effect run (when enabled was true) handles
  // teardown via the returned function below. Keeping all setState
  // calls inside the cleanup avoids the ``react-hooks/set-state-in-effect``
  // lint and matches React's intended pattern for effects.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const start = async () => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getDisplayMedia
      ) {
        setPhase('error');
        setError('Screen sharing not supported in this browser');
        onAutoDisableRef.current?.();
        return;
      }
      setPhase('requesting');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'monitor' } as MediaTrackConstraints,
          audio: false,
        });
      } catch (e) {
        if (cancelled) return;
        setPhase('error');
        setError(
          e instanceof Error
            ? e.message
            : 'Screen-share permission denied',
        );
        // Permission denial / cancel → flip the toggle back off so
        // the UI doesn't get stuck showing "observing" while the
        // user never granted access.
        onAutoDisableRef.current?.();
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setPhase('observing');

      // Detect the user clicking the browser's "Stop sharing"
      // button: every track's ``onended`` fires; we flip the
      // toggle so the parent UI stays in sync.
      stream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (cancelled) return;
          teardown();
          onAutoDisableRef.current?.();
        });
      });

      // First capture happens immediately (the user just gave
      // permission — they expect to see *something* land).
      void doUpload(false);
      intervalRef.current = setInterval(() => {
        if (cancelled) return;
        void doUpload(false);
      }, intervalMs);
    };

    void start();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [enabled, intervalMs, teardown, doUpload]);

  return {
    phase,
    error,
    lastCapturedAt,
    lastTriggerFired,
    uploadsInFlight,
    captureNow,
  };
}
