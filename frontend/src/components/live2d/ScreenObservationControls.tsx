/**
 * ScreenObservationControls — V3 proactive screen-share toggle.
 *
 * Renders alongside ``AudioControls`` (TTS) and ``STTControls`` in
 * the VTuber tab header. When toggled ON:
 *
 *   * Browser prompts the user once for ``getDisplayMedia``; the
 *     selected window/screen/tab is shared for the duration of the
 *     toggle.
 *   * Every 3 minutes (configurable) the hook captures a frame and
 *     uploads it to ``/api/vtuber/screen-observation/upload``.
 *   * The header shows a live "observing" / "capturing" pill plus a
 *     ``Show Now`` button that uploads immediately with
 *     ``force_trigger=true`` (bypasses the backend cooldown).
 *
 * Privacy / consent: this UI must be unambiguously visible whenever
 * the share is active — the browser's own indicator already does
 * most of the work, but a coloured pill in the chat header is the
 * frontend-side affordance reminding the user the persona is
 * watching.
 */

'use client';

import { useCallback, useMemo } from 'react';
import { useVTuberStore } from '@/store/useVTuberStore';
import { useI18n } from '@/lib/i18n';
import { useScreenObservation } from '@/lib/useScreenObservation';
import { Loader2, Monitor, MonitorOff, Zap } from 'lucide-react';

export default function ScreenObservationControls({
  sessionId,
}: { sessionId: string }) {
  const { t } = useI18n();
  const enabled = useVTuberStore((s) => s.screenObservationEnabled);
  const setEnabled = useVTuberStore((s) => s.setScreenObservationEnabled);
  const toggle = useVTuberStore((s) => s.toggleScreenObservation);
  const addLog = useVTuberStore((s) => s.addLog);

  const onAutoDisable = useCallback(() => {
    setEnabled(false);
  }, [setEnabled]);

  const onUploadResult = useCallback(
    (result: { trigger_fired: boolean; caption: string; skipped_reason: string | null }) => {
      const summary = result.caption ? `: ${result.caption.slice(0, 80)}` : '';
      if (result.trigger_fired) {
        addLog(sessionId, 'info', 'screen-obs',
          `observation captured + trigger fired${summary}`,
        );
      } else {
        addLog(sessionId, 'info', 'screen-obs',
          `observation captured (silent: ${result.skipped_reason ?? 'cooldown'})${summary}`,
        );
      }
    },
    [sessionId, addLog],
  );

  const screenIntervalMs = useVTuberStore((s) => s.screenIntervalMs);
  const screenSourceId = useVTuberStore((s) => s.screenSourceId);

  const {
    phase, error, lastCapturedAt, lastTriggerFired, uploadsInFlight,
    captureNow,
  } = useScreenObservation({
    enabled,
    sessionId,
    intervalMs: screenIntervalMs,
    sourceId: screenSourceId,
    onAutoDisable,
    onUploadResult,
  });

  const phaseLabel: string = useMemo(() => {
    if (!enabled) return '';
    if (phase === 'requesting') return 'requesting…';
    if (phase === 'capturing') return 'capturing…';
    if (phase === 'error') return 'error';
    return 'observing';
  }, [enabled, phase]);

  // Compute "Xm ago" inline. ``Date.now()`` makes the value render-
  // impure; we explicitly accept that — the label refreshes on the
  // next state-driven re-render (which is plenty often for a status
  // pill) and adding a 30s interval just to keep the timestamp
  // technically pure would be heavier than the value provides.
  // eslint-disable-next-line react-hooks/purity
  const _agoMs = lastCapturedAt ? Math.max(0, Date.now() - lastCapturedAt) : null;
  const lastAgoLabel = _agoMs === null
    ? ''
    : (_agoMs < 60_000 ? 'just now' : `${Math.floor(_agoMs / 60_000)}m ago`);

  const isErroring = phase === 'error' || !!error;

  const buttonClass = useMemo(() => {
    if (!enabled) {
      return 'bg-transparent text-[var(--text-muted)] border-[var(--border-color)] opacity-60';
    }
    if (isErroring) {
      return 'bg-red-500/10 text-red-500 border-red-500/30';
    }
    if (phase === 'capturing') {
      return 'bg-amber-500/10 text-amber-500 border-amber-500/40';
    }
    return 'bg-[rgba(139,92,246,0.12)] text-purple-400 border-purple-400/35';
  }, [enabled, isErroring, phase]);

  const title = error
    ? `Screen share error: ${error}`
    : enabled
      ? `${phaseLabel}${lastAgoLabel ? ` · last ${lastAgoLabel}` : ''}${lastTriggerFired === true ? ' · last frame triggered a reaction' : ''}`
      : (t('screenObs.clickToEnable') ?? 'Click to enable screen sharing — VTuber will peek every 3 min');

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggle}
        className={`flex items-center gap-1 px-2 py-0.5 text-[0.6875rem] rounded-full border cursor-pointer transition-all duration-150 ${buttonClass}`}
        title={title}
      >
        {enabled ? (
          <Monitor
            size={14}
            className={phase === 'capturing' ? 'animate-pulse' : ''}
          />
        ) : (
          <MonitorOff size={14} />
        )}
        <span>SCRN</span>
      </button>

      {enabled && !isErroring && (
        <div className="flex items-center gap-1">
          <span className="text-[0.6rem] text-[var(--text-muted)] min-w-[3rem]">
            {phaseLabel}
          </span>
          {lastAgoLabel && (
            <span
              className="text-[0.6rem] text-[var(--text-muted)] opacity-70 tabular-nums"
              title={`Last frame ${lastAgoLabel}`}
            >
              · {lastAgoLabel}
            </span>
          )}
          {uploadsInFlight > 0 && (
            <Loader2 size={11} className="spin text-[var(--primary-color)]" />
          )}
          <button
            type="button"
            onClick={captureNow}
            disabled={uploadsInFlight > 0 || phase === 'requesting'}
            title="Show Now — capture immediately, bypass the 10-min cooldown"
            className="ml-1 inline-flex items-center gap-1 px-1.5 py-[2px] text-[0.6rem] rounded-full border border-purple-400/30 bg-purple-500/10 text-purple-400 cursor-pointer hover:bg-purple-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Zap size={9} />
            <span>now</span>
          </button>
        </div>
      )}

      {isErroring && (
        <span
          className="text-[0.625rem] text-red-500 truncate max-w-[10rem]"
          title={error ?? 'error'}
        >
          ⚠ {error ?? 'error'}
        </span>
      )}
    </div>
  );
}
