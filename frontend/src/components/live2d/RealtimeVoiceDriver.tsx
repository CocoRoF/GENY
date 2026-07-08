'use client';

/**
 * RealtimeVoiceDriver — full-duplex hands-free voice conversation.
 *
 * A third voice mode alongside STTControls (inbox/Opsidian capture) and
 * PushToTalkDriver (utterance→chat). When `active`, it opens the realtime
 * voice WebSocket (`/ws/voice/realtime/{sid}`) and plays the persona's
 * streamed reply through the shared AudioManager — so the avatar lip-syncs
 * for free.
 *
 * Two input modes (config `realtimeInputMode`, default `server_vad`):
 *   • server_vad — stream raw 16 kHz PCM continuously; the BACKEND runs
 *     Silero VAD and decides end-of-speech. This is the "realtime input
 *     accumulates, end-of-speech goes straight to the executor" flow. The
 *     server emits `speech_start`, on which we cut local playback (barge-in).
 *   • client_vad — the browser's VAD segments complete utterances (webm)
 *     and uploads each; barge-in fires on local speech onset.
 *
 * Additive: reuses AudioManager (playback/lip-sync) + the existing subtitle
 * box; never touches the existing chat/TTS paths. The store enforces mutual
 * exclusion with STT (single mic owner).
 */

import { useCallback, useEffect, useRef } from 'react';
import { useVoiceActivityRecorder } from '@/lib/useVoiceActivityRecorder';
import { useVTuberStore } from '@/store/useVTuberStore';
import { getAudioManager } from '@/lib/audioManager';
import { openRealtimeVoiceWs } from '@/lib/api';
import { startPcmStream, type PcmStreamHandle } from '@/lib/pcmStreamer';

interface ServerEvent {
  type: string;
  data?: Record<string, unknown>;
}

export default function RealtimeVoiceDriver({
  sessionId,
  active,
}: {
  sessionId: string;
  active: boolean;
}) {
  const inputMode = useVTuberStore((s) => s.realtimeInputMode);
  const clientVad = inputMode === 'client_vad';

  const wsRef = useRef<WebSocket | null>(null);
  const currentTurnRef = useRef<string | null>(null);
  const turnTextRef = useRef('');
  const pcmHandleRef = useRef<PcmStreamHandle | null>(null);

  const cutPlayback = useCallback(() => {
    const am = getAudioManager();
    if (currentTurnRef.current) am.clearTurn(currentTurnRef.current, true);
  }, []);

  const handleServerEvent = useCallback(
    (msg: ServerEvent) => {
      const am = getAudioManager();
      const d = msg.data ?? {};
      switch (msg.type) {
        case 'ready':
          break;
        case 'speech_start':
          // Server VAD detected the user speaking → barge in on the reply.
          cutPlayback();
          useVTuberStore.getState().settleSubtitle(sessionId);
          break;
        case 'speech_end':
        case 'transcript':
          // (user transcript not surfaced in the avatar subtitle box)
          break;
        case 'turn_start': {
          const turnId = `rt:${sessionId}:${d.turn}`;
          currentTurnRef.current = turnId;
          turnTextRef.current = '';
          am.registerTurnStart(turnId, 0);
          break;
        }
        case 'assistant_text': {
          const text = String(d.text ?? '');
          if (text) {
            turnTextRef.current = (turnTextRef.current + ' ' + text).trim();
            useVTuberStore.getState().setSubtitle(sessionId, turnTextRef.current, true);
          }
          break;
        }
        case 'audio': {
          const b64 = String(d.audio_b64 ?? '');
          if (!b64) break;
          const turnId = `rt:${sessionId}:${d.turn}`;
          const seq = Number(d.seq ?? 0);
          const bytes = base64ToBytes(b64);
          const fmt = String(d.format ?? 'wav');
          const blob = new Blob([bytes.buffer as ArrayBuffer], {
            type: fmt === 'wav' ? 'audio/wav' : 'audio/mpeg',
          });
          void am.enqueue(new Response(blob), sessionId, undefined, undefined, { turnId, seq });
          break;
        }
        case 'cancelled': {
          const turnId = `rt:${sessionId}:${d.turn}`;
          am.clearTurn(turnId, true);
          useVTuberStore.getState().settleSubtitle(sessionId);
          break;
        }
        case 'turn_end':
          useVTuberStore.getState().settleSubtitle(sessionId);
          break;
        default:
          break;
      }
    },
    [sessionId, cutPlayback],
  );

  // ── WebSocket lifecycle + server_vad PCM streaming ───────────────
  useEffect(() => {
    if (!active) return;

    let closed = false;
    const ws = openRealtimeVoiceWs(sessionId);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    const am = getAudioManager();
    am.ensureResumed();

    ws.onopen = () => {
      if (closed) return;
      ws.send(JSON.stringify({ type: 'start', language: '', input_mode: inputMode }));
      // server_vad: begin streaming raw PCM immediately.
      if (!clientVad) {
        startPcmStream({
          onFrame: (pcm) => {
            const sock = wsRef.current;
            if (sock && sock.readyState === WebSocket.OPEN) sock.send(pcm);
          },
        })
          .then((h) => {
            if (closed) h.stop();
            else pcmHandleRef.current = h;
          })
          .catch((e) => console.error('[realtime-voice] pcm stream failed', e));
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        handleServerEvent(JSON.parse(ev.data));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = ws.onerror = () => {};

    return () => {
      closed = true;
      pcmHandleRef.current?.stop();
      pcmHandleRef.current = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      wsRef.current = null;
      if (currentTurnRef.current) {
        am.clearTurn(currentTurnRef.current, true);
        currentTurnRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, inputMode, clientVad]);

  // ── client_vad: local VAD onset → barge-in signal ────────────────
  const onSpeechStart = useCallback(() => {
    cutPlayback();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'speech_started' }));
    }
  }, [cutPlayback]);

  // ── client_vad: each utterance → upload as a webm blob ───────────
  const onUtterance = useCallback(async (blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(await blob.arrayBuffer());
    } catch (e) {
      console.error('[realtime-voice] utterance send failed', e);
    }
  }, []);

  // Hook is always called (rules of hooks); enabled only in client_vad mode.
  useVoiceActivityRecorder({
    enabled: active && clientVad,
    onUtterance,
    onSpeechStart,
    pauseWhileSpeaking: false,
    isAgentSpeaking: false,
    speechThreshold: useVTuberStore.getState().sttSensitivity,
    silenceTrailMs: useVTuberStore.getState().sttSilenceMs,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });

  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
