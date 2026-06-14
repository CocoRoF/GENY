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
// Voice + screen drivers live ONLY here (the avatar window), so audio plays once.
const AudioControls = dynamic(() => import('@/components/live2d/AudioControls'), { ssr: false });
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

  // While locked, hovering the control bar makes the window briefly interactive
  // so its buttons are clickable; leaving it returns to click-through.
  const onBarEnter = () => {
    if (locked) window.connector?.windowControl.setClickThrough(false);
  };
  const onBarLeave = () => {
    if (locked) window.connector?.windowControl.setClickThrough(true);
  };

  if (error) return <div style={MSG}>{error}</div>;
  if (!resolved) return <div style={MSG}>아바타 불러오는 중…</div>;

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: 'transparent', display: 'flex', flexDirection: 'column' }}>
      {/* Avatar fills the window; draggable to reposition only when unlocked. */}
      <div
        style={{ flex: 1, minHeight: 0, position: 'relative', WebkitAppRegion: locked ? 'no-drag' : 'drag' } as CSSProperties}
      >
        <AvatarCanvas sessionId={resolved.sid} backgroundAlpha={0} className="w-full h-full" />
      </div>

      {/* Control bar — always interactive (no-drag). TTS/STT/screen toggles +
          lock. This is where voice + screen actually run (single audio source). */}
      <div onMouseEnter={onBarEnter} onMouseLeave={onBarLeave} style={BAR}>
        <AudioControls sessionId={resolved.sid} />
        <STTControls sessionId={resolved.sid} />
        <ScreenObservationControls sessionId={resolved.sid} />
        <button
          type="button"
          onClick={() => setLocked((v) => !v)}
          title={locked ? '고정됨 — 클릭하면 이동/크기조절 가능' : '이동 모드 — 클릭하면 고정'}
          style={LOCK_BTN}
        >
          {locked ? '🔒' : '🔓'}
        </button>
      </div>

      {/* Hidden orchestrator: subscribes to the room's chat WS and drives
          TTS + lip-sync. Off-screen + inert so its effects run without UI. */}
      {resolved.rid && (
        <div
          aria-hidden
          style={{ position: 'fixed', left: -99999, top: 0, width: 380, height: 380, opacity: 0, pointerEvents: 'none' }}
        >
          <VTuberChatPanel sessionId={resolved.sid} roomId={resolved.rid} />
        </div>
      )}
    </div>
  );
}

const BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  justifyContent: 'center',
  flexWrap: 'wrap',
  padding: '6px 10px',
  margin: '0 8px 8px',
  borderRadius: 12,
  background: 'rgba(18,18,24,0.78)',
  backdropFilter: 'blur(8px)',
  boxShadow: '0 4px 18px rgba(0,0,0,0.4)',
  color: '#e8e8f0',
  // The bar must stay clickable even when the avatar above is in drag mode.
  WebkitAppRegion: 'no-drag',
} as CSSProperties;

const LOCK_BTN: CSSProperties = {
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'transparent',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 14,
  cursor: 'pointer',
  lineHeight: 1,
};

const MSG: CSSProperties = {
  width: '100vw',
  height: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  color: '#e8e8f0',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  textAlign: 'center',
  padding: 24,
};
