'use client';

/**
 * RealtimeVoiceDriver — full-duplex hands-free voice conversation.
 *
 * A third voice mode alongside STTControls (inbox capture) and
 * PushToTalkDriver (utterance→chat). When `active`, it opens the realtime
 * voice WebSocket (`/ws/voice/realtime/{sid}`), streams each VAD-detected
 * utterance up, and plays the persona's streamed reply back through the
 * shared AudioManager — so the avatar lip-syncs for free.
 *
 * Barge-in: the mic keeps capturing while the avatar speaks
 * (`pauseWhileSpeaking:false`). The instant the local VAD opens an
 * utterance, it stops the current playback AND signals the server so the
 * in-flight persona turn is cancelled.
 *
 * Additive: reuses useVoiceActivityRecorder (capture) + AudioManager
 * (playback/lip-sync). It does not touch the existing chat/TTS paths; the
 * store enforces mutual exclusion with STT/PTT.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useVoiceActivityRecorder } from '@/lib/useVoiceActivityRecorder';
import { useVTuberStore } from '@/store/useVTuberStore';
import { getAudioManager } from '@/lib/audioManager';
import { openRealtimeVoiceWs } from '@/lib/api';

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
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const currentTurnRef = useRef<string | null>(null);
  // Accumulated assistant text for the current turn (drives the overlay
  // subtitle box, reusing the existing subtitle rendering).
  const turnTextRef = useRef('');

  // ── WebSocket lifecycle (open while active) ──────────────────────
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
      // Empty language = Whisper auto-detect (Korean/English both covered).
      ws.send(JSON.stringify({ type: 'start', language: '' }));
    };

    ws.onmessage = async (ev) => {
      let msg: ServerEvent;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      await handleServerEvent(msg, am);
    };

    ws.onclose = () => {
      readyRef.current = false;
    };
    ws.onerror = () => {
      readyRef.current = false;
    };

    return () => {
      closed = true;
      readyRef.current = false;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      wsRef.current = null;
      // Drop any queued realtime audio on teardown.
      if (currentTurnRef.current) {
        am.clearTurn(currentTurnRef.current, true);
        currentTurnRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId]);

  const handleServerEvent = useCallback(
    async (msg: ServerEvent, am: ReturnType<typeof getAudioManager>) => {
      const d = msg.data ?? {};
      switch (msg.type) {
        case 'ready':
          readyRef.current = true;
          break;
        case 'transcript':
          // User transcript — Phase 1 doesn't surface it in the overlay
          // (the avatar subtitle box is for the persona). Kept for logs.
          break;
        case 'turn_start': {
          const turnId = `rt:${sessionId}:${d.turn}`;
          currentTurnRef.current = turnId;
          turnTextRef.current = '';
          am.registerTurnStart(turnId, 0);
          break;
        }
        case 'assistant_text': {
          // Accumulate sentences into the existing overlay subtitle box.
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
          // Synthetic Response so we reuse AudioManager.enqueue verbatim
          // (it reads response.blob() → decodeAudioData → lip-sync).
          const blob = new Blob([bytes.buffer as ArrayBuffer], {
            type: fmt === 'wav' ? 'audio/wav' : 'audio/mpeg',
          });
          const resp = new Response(blob);
          void am.enqueue(resp, sessionId, undefined, undefined, { turnId, seq });
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
        case 'heartbeat':
        case 'pong':
        default:
          break;
      }
    },
    [sessionId],
  );

  // ── barge-in: cut local playback + tell the server the moment we speak ──
  const onSpeechStart = useCallback(() => {
    const am = getAudioManager();
    if (currentTurnRef.current) {
      am.clearTurn(currentTurnRef.current, true);
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'speech_started' }));
    }
  }, []);

  // ── each detected utterance → upload over the WS ─────────────────
  const onUtterance = useCallback(async (blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const buf = await blob.arrayBuffer();
      ws.send(buf); // binary uplink = raw utterance audio (webm)
    } catch (e) {
      console.error('[realtime-voice] utterance send failed', e);
    }
  }, []);

  useVoiceActivityRecorder({
    enabled: active,
    onUtterance,
    onSpeechStart,
    // Keep capturing while the avatar talks so the user can barge in.
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
