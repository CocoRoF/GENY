'use client';

/**
 * AvatarSubtitle — the visual-novel-style dialogue box pinned to the BOTTOM of
 * the avatar overlay. It mirrors what the VTuber is saying (fed live into
 * useVTuberStore.subtitle by VTuberChatPanel) rather than a head speech-bubble.
 *
 * Behaviour (per the connector spec):
 *   • Shows the response as it streams in. Long text is clipped from the TOP
 *     (newest lines stay visible at the bottom) — flex column + justify-end +
 *     overflow:hidden.
 *   • Dismissal: ~3s after it SETTLES. Settled = streaming finished AND, when TTS
 *     is on, the voice has stopped — so with TTS it lingers until ~3s after the
 *     last spoken audio; without TTS, ~3s after the text finishes streaming.
 *   • The whole thing is click-through (pointer-events:none) so it never blocks
 *     the avatar / desktop beneath the transparent overlay window.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useVTuberStore } from '@/store/useVTuberStore';

const DISMISS_MS = 3000;

export default function AvatarSubtitle({ sessionId }: { sessionId: string }) {
  const sub = useVTuberStore((s) => s.subtitle[sessionId]);
  const speaking = useVTuberStore((s) => s.ttsSpeaking[sessionId] ?? false);
  const ttsEnabled = useVTuberStore((s) => s.ttsEnabled);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const text = sub?.text?.trim() ?? '';
  const streaming = sub?.streaming ?? false;

  useEffect(() => {
    if (!text) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // Settled → arm the dismissal. While streaming, or while TTS is still
    // speaking, we keep it up (no timer); the effect re-runs when those change.
    const settled = !streaming && !(ttsEnabled && speaking);
    if (settled) {
      timer.current = setTimeout(() => setVisible(false), DISMISS_MS);
    }
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [text, streaming, speaking, ttsEnabled]);

  if (!text) return null;

  return (
    <div style={WRAP}>
      <div style={{ ...BOX, opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(8px)' }}>
        <div style={TEXT}>{text}</div>
      </div>
    </div>
  );
}

const WRAP: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 12,
  display: 'flex',
  justifyContent: 'center',
  padding: '0 14px',
  pointerEvents: 'none',
  zIndex: 20,
};

const BOX: CSSProperties = {
  maxWidth: '94%',
  maxHeight: '6.4em', // ~4 lines; older lines clip off the TOP (justify-end + hidden)
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  padding: '11px 16px',
  borderRadius: 14,
  background: 'rgba(12, 12, 20, 0.82)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.45)',
  transition: 'opacity 0.35s ease, transform 0.35s ease',
};

const TEXT: CSSProperties = {
  flexShrink: 0, // keep full height so overflow clips the top instead of squashing
  color: '#f3f3f8',
  fontSize: 15,
  lineHeight: 1.55,
  fontWeight: 500,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  textShadow: '0 1px 3px rgba(0, 0, 0, 0.55)',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};
