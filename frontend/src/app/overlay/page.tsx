'use client';

/**
 * /overlay — the transparent avatar surface the desktop connector loads.
 *
 * Reuses the proven browser stack with NO porting: AvatarCanvas (Live2D/Spine)
 * driven by the same zustand store + avatar-state WS, and a hidden
 * VTuberChatPanel that orchestrates chat→TTS→lip-sync exactly as the dashboard
 * does. The connector points an Electron transparent window at
 * `${serverUrl}/overlay?token=<jwt>` (and optionally &session=&room=); a normal
 * browser can open the same URL (when logged in) to verify rendering.
 *
 * Query params:
 *   token   — JWT; stored to localStorage so apiCall + makeAuthedWs use it.
 *   session — session_id to render (default: first role==='vtuber' session).
 *   room    — chat room_id for TTS (default: the session's chat_room_id).
 */

import { useEffect, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import { setToken } from '@/lib/authApi';
import { agentApi } from '@/lib/api';
import { useVTuberStore } from '@/store/useVTuberStore';

// Browser-only (pixi.js + Spine/Live2D runtime) — never SSR.
const AvatarCanvas = dynamic(() => import('@/components/avatar/AvatarCanvas'), { ssr: false });
const VTuberChatPanel = dynamic(() => import('@/components/live2d/VTuberChatPanel'), { ssr: false });
// Voice + screen DRIVERS live ONLY here (the avatar window), so audio plays once.
// Mounted hidden (off-screen) — they run getUserMedia / getDisplayMedia / TTS
// based on store state; the visible compact bar below toggles that same state.
const STTControls = dynamic(() => import('@/components/live2d/STTControls'), { ssr: false });
const ScreenObservationControls = dynamic(
  () => import('@/components/live2d/ScreenObservationControls'),
  { ssr: false },
);

export default function OverlayPage() {
  const [resolved, setResolved] = useState<{ sid: string; rid: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Locked (default): the avatar is click-through + fixed (no move/resize); only
  // the control bar is interactive. Unlocked: whole window draggable to reposition.
  const [locked, setLocked] = useState(true);

  const fetchModels = useVTuberStore((s) => s.fetchModels);
  const fetchAssignment = useVTuberStore((s) => s.fetchAssignment);
  const subscribeAvatar = useVTuberStore((s) => s.subscribeAvatar);
  const unsubscribeAvatar = useVTuberStore((s) => s.unsubscribeAvatar);
  const assignedModel = useVTuberStore((s) => (resolved ? s.assignments[resolved.sid] : undefined));

  // Compact control state (the bar's toggles read/drive the same store the
  // hidden driver components use).
  const ttsEnabled = useVTuberStore((s) => s.ttsEnabled);
  const sttEnabled = useVTuberStore((s) => s.sttEnabled);
  const screenOn = useVTuberStore((s) => s.screenObservationEnabled);
  const toggleTTS = useVTuberStore((s) => s.toggleTTS);
  const toggleSTT = useVTuberStore((s) => s.toggleSTT);
  const toggleScreen = useVTuberStore((s) => s.toggleScreenObservation);

  // 1) token + transparency + resolve the target session (once).
  useEffect(() => {
    // The desktop overlay window is transparent; globals.css paints an opaque
    // body, so clear it at runtime to composite onto the desktop.
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';

    const qs = new URLSearchParams(window.location.search);
    const token = qs.get('token');
    if (token) setToken(token);
    const wantSession = qs.get('session');
    const wantRoom = qs.get('room');

    let cancelled = false;
    (async () => {
      try {
        const sessions = await agentApi.list();
        const target = wantSession
          ? sessions.find((s) => s.session_id === wantSession)
          : sessions.find((s) => s.role === 'vtuber') ?? sessions[0];
        if (!target) {
          if (!cancelled) setError('표시할 VTuber 세션이 없습니다. 서버에서 VTuber 세션을 먼저 만들어 주세요.');
          return;
        }
        if (!cancelled) setResolved({ sid: target.session_id, rid: wantRoom ?? target.chat_room_id ?? null });
      } catch (e) {
        if (!cancelled) setError(`세션을 불러오지 못했습니다: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2) load models + this session's assignment.
  useEffect(() => {
    if (!resolved) return;
    fetchModels();
    fetchAssignment(resolved.sid);
  }, [resolved, fetchModels, fetchAssignment]);

  // 3) subscribe to avatar-state once a model is assigned (mirrors VTuberPanel).
  useEffect(() => {
    if (!resolved || !assignedModel) return;
    subscribeAvatar(resolved.sid);
    return () => unsubscribeAvatar(resolved.sid);
  }, [resolved, assignedModel, subscribeAvatar, unsubscribeAvatar]);

  // Apply the lock state to the OS window. Locked → click-through (the avatar
  // ignores the mouse; only the control bar, via hover below, re-enables input).
  // Unlocked → the whole window captures input so it can be dragged to reposition.
  useEffect(() => {
    window.connector?.windowControl.setClickThrough(locked);
  }, [locked]);

  // While locked, hovering the (tiny) control re-enables input so it is clickable;
  // leaving returns to click-through.
  const onBarEnter = () => {
    if (locked) window.connector?.windowControl.setClickThrough(false);
  };
  const onBarLeave = () => {
    if (locked) window.connector?.windowControl.setClickThrough(true);
  };

  // Drag the BOTTOM BAR to move the whole window. (The avatar itself keeps the
  // renderer's native pan/zoom — see AvatarCanvas interactive — so dragging the
  // avatar pans it, dragging the bar moves the window.) Clicks on buttons are
  // excluded so toggles still work.
  const onBarDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const onMove = (ev: MouseEvent) => window.connector?.windowControl.moveBy(ev.movementX, ev.movementY);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (error) return <Loading label={error} error />;
  if (!resolved) return <Loading label="아바타 불러오는 중…" />;

  return (
    <div style={ROOT}>
      {/* Avatar — the renderer's OWN crisp pan/zoom (drag = pan, wheel = zoom),
          active when the window is interactive (unlocked). No CSS scaling. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <AvatarCanvas sessionId={resolved.sid} interactive backgroundAlpha={0} className="w-full h-full" />
      </div>

      {/* The bar is the MOVE handle: drag its background → move the whole window.
          Locked → just a small lock chip. Unlocked → the full compact bar. */}
      {locked ? (
        <div style={{ ...LOCK_ONLY, cursor: 'move' }} onMouseEnter={onBarEnter} onMouseLeave={onBarLeave} onMouseDown={onBarDrag}>
          <button type="button" onClick={() => setLocked(false)} title="잠금 해제 — 이동·설정" style={ICON_BTN}>
            <LockIcon open={false} />
          </button>
        </div>
      ) : (
        <div style={{ ...BAR, cursor: 'move' }} onMouseEnter={onBarEnter} onMouseLeave={onBarLeave} onMouseDown={onBarDrag}>
          <Toggle active={ttsEnabled} onClick={toggleTTS} label="TTS" title="음성 출력" />
          {/* Drag handle — a NON-button so bar-drag fires on it; widens the grab
              area and signals the window is movable. */}
          <span style={GRIP} title="드래그하여 아바타 이동">
            <GripIcon />
          </span>
          <Toggle active={sttEnabled} onClick={toggleSTT} label="STT" title="음성 입력 (마이크)" />
          <Toggle active={screenOn} onClick={toggleScreen} label="화면" title="화면 관찰" />
          <span style={DIVIDER} />
          <button type="button" onClick={() => setLocked(true)} title="잠금" style={ICON_BTN}>
            <LockIcon open />
          </button>
        </div>
      )}

      {/* Hidden drivers: TTS+lip-sync (chat WS), STT recorder, screen capture —
          run off-screen, toggled by the bar above via shared store state. */}
      <div aria-hidden style={HIDDEN}>
        {resolved.rid && <VTuberChatPanel sessionId={resolved.sid} roomId={resolved.rid} />}
        <STTControls sessionId={resolved.sid} />
        <ScreenObservationControls sessionId={resolved.sid} />
      </div>
    </div>
  );
}

// ── compact bar pieces ───────────────────────────────────────────────────────
function Toggle({ active, onClick, label, title }: { active: boolean; onClick: () => void; label: string; title: string }) {
  return (
    <button type="button" onClick={onClick} title={title} style={pill(active)}>
      <span style={dot(active)} />
      {label}
    </button>
  );
}
function LockIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d={open ? 'M7 11V7a5 5 0 0 1 9.9-1' : 'M7 11V7a5 5 0 0 1 10 0v4'} />
    </svg>
  );
}
function GripIcon() {
  return (
    <svg width="13" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {[6, 12, 18].map((cy) => (
        <g key={cy}>
          <circle cx="9" cy={cy} r="1.7" />
          <circle cx="15" cy={cy} r="1.7" />
        </g>
      ))}
    </svg>
  );
}

// Proper loading / error screen (the overlay window is transparent).
function Loading({ label, error }: { label: string; error?: boolean }) {
  return (
    <div style={LOAD_WRAP}>
      <style>{'@keyframes geny-spin{to{transform:rotate(360deg)}}'}</style>
      <div style={LOAD_CARD}>
        {error ? (
          <div style={{ fontSize: 22 }}>⚠️</div>
        ) : (
          <div style={SPINNER} />
        )}
        <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.3 }}>Geny</div>
        <div style={{ fontSize: 11, opacity: 0.65, maxWidth: 240, textAlign: 'center', lineHeight: 1.5 }}>{label}</div>
      </div>
    </div>
  );
}
// ── styles ───────────────────────────────────────────────────────────────────
const ROOT: CSSProperties = { width: '100vw', height: '100vh', overflow: 'hidden', background: 'transparent', display: 'flex', flexDirection: 'column' };

const BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  justifyContent: 'center',
  padding: '5px 8px',
  margin: '0 auto 8px',
  width: 'fit-content',
  maxWidth: 'calc(100% - 16px)',
  borderRadius: 999,
  background: 'rgba(18,18,24,0.82)',
  backdropFilter: 'blur(10px)',
  boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
  color: '#e8e8f0',
};

const LOCK_ONLY: CSSProperties = {
  alignSelf: 'center',
  margin: '0 auto 10px',
  borderRadius: 999,
  background: 'rgba(18,18,24,0.7)',
  backdropFilter: 'blur(8px)',
  boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
  color: '#cfd0e0',
  padding: 2,
};

const ICON_BTN: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  background: 'transparent',
  borderRadius: 8,
  color: '#cfd0e0',
  cursor: 'pointer',
};

const DIVIDER: CSSProperties = { width: 1, height: 18, background: 'rgba(255,255,255,0.14)', margin: '0 2px' };

const GRIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 4px',
  color: 'rgba(255,255,255,0.5)',
  cursor: 'grab',
};

const LOAD_WRAP: CSSProperties = {
  width: '100vw',
  height: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
};
const LOAD_CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 10,
  padding: '20px 26px',
  borderRadius: 16,
  background: 'rgba(18,18,24,0.78)',
  backdropFilter: 'blur(10px)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
  color: '#e8e8f0',
};
const SPINNER: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: '50%',
  border: '3px solid rgba(255,255,255,0.15)',
  borderTopColor: '#7c84ff',
  animation: 'geny-spin 0.8s linear infinite',
};

function pill(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    border: 'none',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    color: active ? '#0c0c10' : '#cfd0e0',
    background: active ? '#5be39a' : 'rgba(255,255,255,0.08)',
  };
}
function dot(active: boolean): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: active ? '#0a7d44' : 'rgba(255,255,255,0.35)',
    boxShadow: active ? '0 0 6px #5be39a' : 'none',
  };
}
const HIDDEN: CSSProperties = { position: 'fixed', left: -99999, top: 0, width: 380, height: 380, opacity: 0, pointerEvents: 'none' };

