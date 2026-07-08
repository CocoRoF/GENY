'use client';

/**
 * RealtimeVoiceDriver — hands-free voice conversation, integrated with the
 * VISIBLE chat.
 *
 * When `active`, it opens the realtime voice WebSocket (`/ws/voice/realtime/
 * {sid}`) and streams the mic to the backend, which runs Silero VAD and, on
 * end-of-speech, transcribes the utterance. In the default `stt_only` mode
 * the server just returns the transcript and THIS driver posts it to the
 * chat room exactly like typing — so the spoken message appears as a user
 * bubble and the persona's reply comes back through the normal chat + TTS
 * path (visible, with lip-sync). The user can SEE what was heard.
 *
 * Live feedback (store): `realtimeListening` while the server hears speech,
 * `realtimePartial` for the interim transcript — rendered as a "듣는 중…"
 * pill so it's obvious the mic is live.
 *
 * Barge-in: on the server's `speech_start`, cut the current TTS and cancel
 * the in-flight persona reply (same as the push-to-talk hotkey).
 *
 * Input modes (store `realtimeInputMode`):
 *   server_vad (default) — stream raw PCM; backend VAD decides end-of-speech.
 *   client_vad           — browser segments utterances (webm) and uploads.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useVoiceActivityRecorder } from '@/lib/useVoiceActivityRecorder';
import { useVTuberStore } from '@/store/useVTuberStore';
import { getAudioManager } from '@/lib/audioManager';
import { openRealtimeVoiceWs, chatApi } from '@/lib/api';
import { startPcmStream, type PcmStreamHandle } from '@/lib/pcmStreamer';
import { grabCurrentScreenAttachment } from '@/lib/screenFrameAccess';

interface ServerEvent {
  type: string;
  data?: Record<string, unknown>;
}

export default function RealtimeVoiceDriver({
  sessionId,
  roomId,
  active,
}: {
  sessionId: string;
  roomId?: string | null;
  active: boolean;
}) {
  const inputMode = useVTuberStore((s) => s.realtimeInputMode);
  const clientVad = inputMode === 'client_vad';

  const wsRef = useRef<WebSocket | null>(null);
  const pcmHandleRef = useRef<PcmStreamHandle | null>(null);

  // ── barge-in: cut current TTS + cancel the in-flight chat reply ──
  const bargeIn = useCallback(() => {
    const st = useVTuberStore.getState();
    st.stopSpeaking(sessionId);
    if (roomId) chatApi.cancelBroadcast(roomId).catch(() => {});
  }, [sessionId, roomId]);

  // ── send a finished transcript into the VISIBLE chat (like typing) ──
  const sendToChat = useCallback(
    async (text: string) => {
      const msg = text.trim();
      if (!msg || !roomId) return;
      try {
        const st = useVTuberStore.getState();
        if (st.ttsEnabled) {
          getAudioManager().ensureResumed();
          st.beginTTSTurn(sessionId);
        }
        const screen = st.screenObservationEnabled
          ? await grabCurrentScreenAttachment()
          : null;
        await chatApi.broadcastToRoom(roomId, {
          message: msg,
          attachments: screen ? [screen] : undefined,
        });
      } catch (e) {
        console.error('[realtime-voice] broadcast failed', e);
      }
    },
    [sessionId, roomId],
  );

  const handleServerEvent = useCallback(
    (msg: ServerEvent) => {
      const st = useVTuberStore.getState();
      const d = msg.data ?? {};
      switch (msg.type) {
        case 'ready':
          break;
        case 'speech_start':
          st.setRealtimeListening(true);
          st.setRealtimePartial('');
          bargeIn(); // user started talking → interrupt the reply
          break;
        case 'speech_end':
          st.setRealtimeListening(false);
          break;
        case 'transcript': {
          const text = String(d.text ?? '');
          if (d.final) {
            st.setRealtimeListening(false);
            st.setRealtimePartial('');
            if (text) void sendToChat(text); // → visible chat message + reply
          } else {
            st.setRealtimePartial(text); // interim caption
          }
          break;
        }
        default:
          // stt_only mode: the server does not stream reply audio here —
          // the reply comes through the normal chat/TTS path.
          break;
      }
    },
    [bargeIn, sendToChat],
  );

  // ── WebSocket lifecycle + server_vad PCM streaming ───────────────
  useEffect(() => {
    if (!active) return;
    let closed = false;
    const ws = openRealtimeVoiceWs(sessionId);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    getAudioManager().ensureResumed();

    ws.onopen = () => {
      if (closed) return;
      ws.send(
        JSON.stringify({ type: 'start', language: '', input_mode: inputMode, stt_only: true }),
      );
      if (!clientVad) {
        startPcmStream({
          onFrame: (pcm) => {
            const sock = wsRef.current;
            if (sock && sock.readyState === WebSocket.OPEN) sock.send(pcm);
          },
        })
          .then((h) => (closed ? h.stop() : (pcmHandleRef.current = h)))
          .catch((e) => console.error('[realtime-voice] pcm stream failed', e));
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        handleServerEvent(JSON.parse(ev.data));
      } catch {
        /* ignore */
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
      const st = useVTuberStore.getState();
      st.setRealtimeListening(false);
      st.setRealtimePartial('');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, inputMode, clientVad]);

  // ── client_vad path (browser segments utterances) ────────────────
  const onSpeechStart = useCallback(() => {
    useVTuberStore.getState().setRealtimeListening(true);
    bargeIn();
  }, [bargeIn]);

  const onUtterance = useCallback(async (blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(await blob.arrayBuffer());
    } catch (e) {
      console.error('[realtime-voice] utterance send failed', e);
    }
  }, []);

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
