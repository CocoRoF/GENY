/**
 * STTControls — VTuber-side voice-activity toggle.
 *
 * V2 of the voice-notes plan. Renders alongside ``AudioControls``
 * (TTS) on the VTuber tab header. When toggled ON:
 *
 *   * Requests the user's mic via :func:`useVoiceActivityRecorder`.
 *   * Each detected utterance is uploaded as an audio capture with
 *     ``auto_spotlight=true`` so the W2 hook + spotlight + USER_SHARED
 *     pipeline delivers it to the VTuber automatically — the persona
 *     reacts via the ``whiteboard-voice-notes`` skill (W4).
 *   * Live level meter + recording-dot pulse give the user real-time
 *     feedback so they know the mic is hot.
 *
 * Echo guard: while ``ttsSpeaking[sessionId]`` is true (VTuber's own
 * TTS is playing), the VAD pauses so it can't grab the speaker output
 * as a fresh utterance. Pair with the ``echoCancellation`` constraint
 * baked into the hook.
 */

'use client';

import { useCallback, useMemo, useState } from 'react';
import { useVTuberStore } from '@/store/useVTuberStore';
import { useI18n } from '@/lib/i18n';
import { useVoiceActivityRecorder } from '@/lib/useVoiceActivityRecorder';
import { whiteboardApi } from '@/lib/api';

export default function STTControls({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const sttEnabled = useVTuberStore((s) => s.sttEnabled);
  const toggleSTT = useVTuberStore((s) => s.toggleSTT);
  const ttsSpeaking = useVTuberStore(
    (s) => s.ttsSpeaking[sessionId] ?? false,
  );
  const addLog = useVTuberStore((s) => s.addLog);

  const [uploading, setUploading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const onUtterance = useCallback(
    async (blob: Blob, durationMs: number) => {
      setLastError(null);
      setUploading(true);
      try {
        const mime = (blob.type || 'audio/webm').split(';', 1)[0] || 'audio/webm';
        const ext = mime.split('/')[1] || 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `voice-${stamp}.${ext}`;
        // upload + auto-spotlight in one server call so the W2 hook
        // can land the transcript on the note before the spotlight
        // excerpt is sampled.
        await whiteboardApi.uploadCapture({
          file: blob,
          type: 'audio',
          source: 'vtuber_stt_stream',
          sessionId,
          filename,
          metadata: {
            content_type: blob.type || 'audio/webm',
            size_bytes: blob.size,
            duration_ms: Math.round(durationMs),
            stt_mode: true,
          },
          autoSpotlight: true,
        });
        addLog(sessionId, 'info', 'stt',
          `utterance captured (${Math.round(durationMs)}ms, ${blob.size}B)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        addLog(sessionId, 'warn', 'stt', `utterance upload failed: ${msg}`);
      } finally {
        setUploading(false);
      }
    },
    [sessionId, addLog],
  );

  const { phase, error, level, utteranceMs } = useVoiceActivityRecorder({
    enabled: sttEnabled,
    onUtterance,
    pauseWhileSpeaking: true,
    isAgentSpeaking: ttsSpeaking,
  });

  const isErroring = phase === 'error' || !!error;
  const isRecording = phase === 'speaking';
  const isListening = phase === 'listening';

  const buttonClass = useMemo(() => {
    if (!sttEnabled) {
      return 'bg-transparent text-[var(--text-muted)] border-[var(--border-color)] opacity-60';
    }
    if (isErroring) {
      return 'bg-red-500/10 text-red-500 border-red-500/30';
    }
    if (isRecording) {
      return 'bg-red-500/15 text-red-400 border-red-400/40';
    }
    return 'bg-[rgba(34,197,94,0.1)] text-green-500 border-green-500/30';
  }, [sttEnabled, isErroring, isRecording]);

  const title = error
    ? `STT error: ${error}`
    : sttEnabled
      ? isRecording
        ? `Recording utterance (${Math.round(utteranceMs)}ms)`
        : ttsSpeaking
          ? 'Paused while VTuber is speaking'
          : (t('stt.clickToDisable') ?? 'Click to disable STT')
      : (t('stt.clickToEnable') ?? 'Click to enable STT — VTuber will listen to your microphone');

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggleSTT}
        className={`flex items-center gap-1 px-2 py-0.5 text-[0.6875rem] rounded-full border cursor-pointer transition-all duration-150 ${buttonClass}`}
        title={title}
      >
        {/* Microphone icon */}
        {sttEnabled ? (
          <svg
            className={`w-3.5 h-3.5 ${isRecording ? 'animate-pulse' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        ) : (
          <svg
            className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2"
          >
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
        <span>STT</span>
      </button>

      {sttEnabled && !isErroring && (
        <div className="flex items-center gap-1">
          {/* Live level / status indicator */}
          <div
            className="w-12 h-1 rounded-full bg-[var(--border-color)] overflow-hidden"
            aria-hidden
          >
            <div
              className={`h-full transition-[width] duration-75 ${
                isRecording ? 'bg-red-400' : 'bg-green-500/70'
              }`}
              style={{ width: `${Math.min(100, Math.round(level * 220))}%` }}
            />
          </div>
          <span className="text-[0.6rem] text-[var(--text-muted)] tabular-nums min-w-[2.5rem]">
            {isRecording
              ? `${(utteranceMs / 1000).toFixed(1)}s`
              : ttsSpeaking
                ? 'muted'
                : isListening
                  ? 'listen'
                  : phase === 'requesting'
                    ? 'opening'
                    : ''}
          </span>
          {uploading && (
            <span className="text-[0.6rem] text-[var(--primary-color)]" title="Uploading utterance">
              ↑
            </span>
          )}
        </div>
      )}

      {lastError && !isErroring && (
        <span
          className="text-[0.625rem] text-red-500 truncate max-w-[10rem]"
          title={lastError}
        >
          ⚠ last upload failed
        </span>
      )}
    </div>
  );
}
