'use client';

/**
 * AvatarSubtitle — the visual-novel-style dialogue box pinned to the BOTTOM of
 * the avatar overlay. It mirrors what the VTuber is saying (fed live into
 * useVTuberStore.subtitle by VTuberChatPanel) rather than a head speech-bubble.
 *
 * Behaviour (per the connector spec):
 *   • TYPEWRITER reveal from the front. Screen-capture / auto-conversation
 *     triggers make the VTuber auto-speak, and those responses arrive ALL AT ONCE
 *     (not streamed) — which looked ugly popping in whole. So we always reveal the
 *     target text character-by-character. The speed adapts: fast enough to keep up
 *     with a real live stream, and caps an all-at-once message at ~MAX_REVEAL_SEC
 *     so it reads as if it were streamed. A new turn restarts the reveal.
 *   • Long text is clipped from the TOP (newest lines stay visible at the bottom).
 *   • Dismissal: ~3s after it SETTLES. Settled = the reveal finished AND streaming
 *     finished AND, when TTS is on, the voice has stopped.
 *   • Click-through (pointer-events:none) so it never blocks the avatar/desktop.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useVTuberStore } from '@/store/useVTuberStore';

const DISMISS_MS = 3000;
const BASE_CPS = 42;          // baseline reveal speed (chars/sec)
const MAX_REVEAL_SEC = 2.6;   // cap: an all-at-once message never takes longer than this

export default function AvatarSubtitle({ sessionId }: { sessionId: string }) {
  const sub = useVTuberStore((s) => s.subtitle[sessionId]);
  const speaking = useVTuberStore((s) => s.ttsSpeaking[sessionId] ?? false);
  const ttsEnabled = useVTuberStore((s) => s.ttsEnabled);
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const full = sub?.text ?? '';
  const streaming = sub?.streaming ?? false;

  // Refs the rAF loop reads without re-subscribing every frame.
  const fullRef = useRef(full);
  fullRef.current = full;
  const shownRef = useRef(0);
  const prevRef = useRef('');

  // Restart the reveal when NEW content arrives (a new turn or an all-at-once
  // message) — i.e. the text is not just the live stream growing (a prefix
  // extension). This is what makes an auto-triggered blast type out from 0.
  useEffect(() => {
    if (!full.startsWith(prevRef.current)) {
      shownRef.current = 0;
      setShown(0);
    }
    prevRef.current = full;
  }, [full]);

  // Persistent typewriter loop — advances `shown` toward the full length.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (ts: number) => {
      if (!last) last = ts;
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      const target = fullRef.current;
      let s = shownRef.current;
      if (s > target.length) s = 0; // defensive: target shrank
      if (s < target.length) {
        const cps = Math.max(BASE_CPS, target.length / MAX_REVEAL_SEC);
        s = Math.min(target.length, s + cps * dt);
        if (Math.floor(s) !== Math.floor(shownRef.current)) setShown(Math.floor(s));
      }
      shownRef.current = s;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const revealed = full.slice(0, shown);
  const revealDone = shown >= full.length;

  useEffect(() => {
    if (!full.trim()) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // Settled → arm the dismissal. Keep it up while still typing, still streaming,
    // or TTS still speaking; the effect re-runs when those change.
    const settled = revealDone && !streaming && !(ttsEnabled && speaking);
    if (settled) {
      timer.current = setTimeout(() => setVisible(false), DISMISS_MS);
    }
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [full, revealDone, streaming, speaking, ttsEnabled]);

  if (!full.trim()) return null;

  return (
    <div style={WRAP}>
      <div style={{ ...BOX, opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(8px)' }}>
        <div style={TEXT}>{revealed}</div>
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
