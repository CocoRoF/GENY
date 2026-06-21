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
import { agentApi, chatApi } from '@/lib/api';
import { useVTuberStore } from '@/store/useVTuberStore';

// Browser-only (pixi.js + Spine/Live2D runtime) — never SSR.
const AvatarCanvas = dynamic(() => import('@/components/avatar/AvatarCanvas'), { ssr: false });
const VTuberChatPanel = dynamic(() => import('@/components/live2d/VTuberChatPanel'), { ssr: false });
// Voice + screen DRIVERS live ONLY here (the avatar window), so audio plays once.
// Mounted hidden (off-screen) — they run getUserMedia / getDisplayMedia / TTS
// based on store state; the visible compact bar below toggles that same state.
const STTControls = dynamic(() => import('@/components/live2d/STTControls'), { ssr: false });
const PushToTalkDriver = dynamic(() => import('@/components/live2d/PushToTalkDriver'), { ssr: false });
const ConnectorBridgeClient = dynamic(() => import('@/components/live2d/ConnectorBridgeClient'), { ssr: false });
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
  // Push-to-talk (global hotkey toggles this). Tap on → mic listens; tapping
  // again (or the same hotkey) toggles off. On the down-edge we also barge in.
  const [pttActive, setPttActive] = useState(false);

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
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Poll until a session exists, so the avatar self-heals when one is created
    // on the server (no connector restart needed).
    const attempt = async () => {
      if (cancelled) return;
      try {
        const sessions = await agentApi.list();
        // Prefer the requested session, but if it's missing (a stale/deleted id
        // saved from a prior run) fall back to auto-detecting a VTuber session,
        // so the overlay SELF-HEALS instead of waiting forever on a dead id.
        // Never fall back to a non-VTuber (e.g. worker) session — it has no
        // avatar/model to render.
        const target =
          (wantSession && sessions.find((s) => s.session_id === wantSession)) ||
          sessions.find((s) => s.role === 'vtuber') ||
          null;
        if (target) {
          if (!cancelled) {
            setError(null);
            setResolved({ sid: target.session_id, rid: wantRoom ?? target.chat_room_id ?? null });
          }
          return; // resolved — stop polling
        }
        if (!cancelled) {
          setError('VTuber 세션을 기다리는 중…\n서버에서 세션을 만들면 자동으로 떠요.');
          timer = setTimeout(attempt, 6000);
        }
      } catch (e) {
        if (!cancelled) {
          setError(`세션 연결 재시도 중…\n(${(e as Error).message})`);
          timer = setTimeout(attempt, 6000);
        }
      }
    };
    attempt();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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

  // Capability tuning lives in the SETTINGS window (계정·음성·앱). It's a
  // different origin, so it arrives via the native config bridge: read it on
  // load and re-apply on every config:changed broadcast → the hidden TTS/STT/
  // screen drivers pick it up live (no reload).
  useEffect(() => {
    const conn = window.connector;
    if (!conn?.serverConfig) return;
    const apply = (t?: {
      ttsVolume?: number; sttSensitivity?: number; sttSilenceMs?: number;
      sttEchoCancellation?: boolean; sttNoiseSuppression?: boolean; sttAutoGain?: boolean;
      screenIntervalMs?: number; screenSourceId?: string | null;
    }) => {
      if (!t) return;
      const st = useVTuberStore.getState();
      if (typeof t.ttsVolume === 'number') st.setTTSVolume(t.ttsVolume);
      st.setSttSettings({
        ...(typeof t.sttSensitivity === 'number' ? { sttSensitivity: t.sttSensitivity } : {}),
        ...(typeof t.sttSilenceMs === 'number' ? { sttSilenceMs: t.sttSilenceMs } : {}),
        ...(typeof t.sttEchoCancellation === 'boolean' ? { sttEchoCancellation: t.sttEchoCancellation } : {}),
        ...(typeof t.sttNoiseSuppression === 'boolean' ? { sttNoiseSuppression: t.sttNoiseSuppression } : {}),
        ...(typeof t.sttAutoGain === 'boolean' ? { sttAutoGain: t.sttAutoGain } : {}),
      });
      st.setScreenSettings({
        ...(typeof t.screenIntervalMs === 'number' ? { screenIntervalMs: t.screenIntervalMs } : {}),
        ...('screenSourceId' in t ? { screenSourceId: t.screenSourceId ?? null } : {}),
      });
    };
    conn.serverConfig.get().then((c) => apply(c.overlayTuning)).catch(() => undefined);
    const off = conn.serverConfig.onChange((c) => apply(c.overlayTuning));
    return () => off?.();
  }, []);

  // Global push-to-talk hotkey (from the connector). On each press: if the avatar
  // is mid-TTS, barge in (cut audio + cancel the agent turn), then toggle the mic.
  useEffect(() => {
    if (!resolved) return;
    const handle = () => {
      const st = useVTuberStore.getState();
      if (st.ttsSpeaking[resolved.sid]) {
        st.stopSpeaking(resolved.sid);
        if (resolved.rid) chatApi.cancelBroadcast(resolved.rid).catch(() => undefined);
      }
      setPttActive((v) => !v);
    };
    const off = window.connector?.hotkeys?.onPushToTalk(handle);
    return () => off?.();
  }, [resolved]);

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
      {/* Push-to-talk "listening" indicator (visual only). */}
      {pttActive && <div style={PTT_PILL}>🎙 듣는 중…</div>}

      {/* Avatar — the renderer's OWN crisp pan/zoom (drag = pan, wheel = zoom),
          active when the window is interactive (unlocked). No CSS scaling. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <AvatarCanvas
          sessionId={resolved.sid}
          interactive
          backgroundAlpha={0}
          className="w-full h-full"
          viewStorageKey={`geny_overlay_view_${resolved.sid}`}
        />
      </div>

      {/* The bar is the MOVE handle: drag its background → move the whole window.
          Locked → just a small lock chip. Unlocked → the full compact bar. */}
      {locked ? (
        <div style={{ ...LOCK_ONLY, cursor: 'move' }} onMouseEnter={onBarEnter} onMouseLeave={onBarLeave} onMouseDown={onBarDrag}>
          <button type="button" onClick={() => setLocked(false)} style={ICON_BTN}>
            <LockIcon open={false} />
          </button>
        </div>
      ) : (
        <div style={{ ...BAR, cursor: 'move' }} onMouseEnter={onBarEnter} onMouseLeave={onBarLeave} onMouseDown={onBarDrag}>
          {/* Drag handle (left of TTS) — a NON-button so bar-drag fires on it;
              widens the grab area and signals the window is movable. */}
          <span style={GRIP} title="드래그하여 아바타 이동">
            <GripIcon />
          </span>
          <Toggle active={ttsEnabled} onClick={toggleTTS} label="TTS" title="음성 출력" />
          <Toggle active={sttEnabled} onClick={toggleSTT} label="STT" title="음성 입력 (마이크)" />
          <Toggle active={screenOn} onClick={toggleScreen} label="화면" title="화면 관찰" />
          <span style={DIVIDER} />
          {/* 말풍선 — open the chat window (the control/chat window). */}
          <button type="button" onClick={() => window.connector?.windowControl.openControl()} title="채팅 창 열기" style={ICON_BTN}>
            <ChatIcon />
          </button>
          {/* 톱니바퀴 — open the settings window (계정·음성·앱: TTS/STT/화면 tuning). */}
          <button type="button" onClick={() => window.connector?.windowControl.openSettings()} title="설정 창 열기" style={ICON_BTN}>
            <GearIcon />
          </button>
          <button type="button" onClick={() => setLocked(true)} title="잠금" style={ICON_BTN}>
            <LockIcon open />
          </button>
        </div>
      )}

      {/* Hidden drivers: TTS+lip-sync (chat WS), STT recorder, screen capture,
          push-to-talk — run off-screen, toggled by the bar above via shared
          store state. The VISIBLE chat lives in the control window (chat tab). */}
      <div aria-hidden style={HIDDEN}>
        {resolved.rid && <VTuberChatPanel sessionId={resolved.sid} roomId={resolved.rid} />}
        {resolved.rid && <PushToTalkDriver sessionId={resolved.sid} roomId={resolved.rid} active={pttActive} />}
        <STTControls sessionId={resolved.sid} />
        <ScreenObservationControls sessionId={resolved.sid} />
        {/* Inverse-MCP capability bridge (desktop only; no-op in a browser). */}
        <ConnectorBridgeClient sessionId={resolved.sid} />
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
function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9.5 9.5 0 0 1-4-.9L3 21l1.9-5.5a8.38 8.38 0 0 1-.9-4 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
        <div style={{ fontSize: 11, opacity: 0.65, maxWidth: 260, textAlign: 'center', lineHeight: 1.5, whiteSpace: 'pre-line' }}>{label}</div>
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

const PTT_PILL: CSSProperties = {
  position: 'absolute',
  top: 10,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 5,
  padding: '4px 12px',
  borderRadius: 999,
  background: 'rgba(220,38,38,0.85)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
  pointerEvents: 'none',
};

