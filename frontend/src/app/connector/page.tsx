'use client';

/**
 * /connector — the desktop connector's control panel (loaded in the control
 * window). Reuses the dashboard's proven control components, no porting:
 * session picker, avatar-model picker, and the full chat panel. A normal
 * browser can open it too (when logged in); inside the Electron connector it
 * also drives the floating overlay's session via window.connector (preload).
 *
 * Query: ?token (→localStorage), ?session (preselect).
 */

import { useEffect, useState, type SVGProps } from 'react';
import { setToken } from '@/lib/authApi';
import { useAppStore } from '@/store/useAppStore';
import { useVTuberStore } from '@/store/useVTuberStore';
import { useTheme, type Theme } from '@/lib/theme';
import VTuberChatPanel from '@/components/live2d/VTuberChatPanel';

// CRITICAL: this is the chat window, a SEPARATE renderer process from the avatar
// overlay. If TTS ran here too, audio would play twice (two AudioManagers). Voice
// (TTS/STT) and screen-scan live ONLY in the avatar window; here we force TTS off
// at module load (before any message can arrive) so chat is silent view+send.
useVTuberStore.setState({ ttsEnabled: false });

/** Resolve the connector's ?theme (dark|light|system) to a concrete theme. */
function resolveConnectorTheme(): Theme | null {
  if (typeof window === 'undefined') return null;
  const t = new URLSearchParams(window.location.search).get('theme');
  if (!t) return null; // plain browser → leave the user's own preference alone
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Apply the connector theme at module load too, so there's no dark→light flash
// before React mounts (the ThemeProvider FOUC script defaults to dark).
(() => {
  const resolved = resolveConnectorTheme();
  if (!resolved) return;
  try {
    localStorage.setItem('geny-theme-preference', resolved);
    const r = document.documentElement;
    r.classList.remove('light', 'dark');
    r.classList.add(resolved);
    r.style.colorScheme = resolved;
  } catch {
    /* ignore */
  }
})();

// ── icons (1.6 stroke, currentColor) ─────────────────────────────────────────
const ic = (p: SVGProps<SVGSVGElement>) => ({
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...p,
});
const RefreshIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...ic(p)}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></svg>
);
const GearIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...ic(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
const PowerIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...ic(p)}><path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04" /></svg>
);
const ChevronIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...ic(p)}><path d="m6 9 6 6 6-6" /></svg>
);
const MonitorIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...ic(p)}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
);
const ExternalIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...ic(p)}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
);

const TOOLBAR_SELECT =
  'appearance-none h-8 pl-2.5 pr-7 text-[0.78rem] rounded-lg bg-[var(--bg-tertiary)]/60 ' +
  'border border-[var(--border-color)] text-[var(--text-primary)] outline-none cursor-pointer ' +
  'min-w-[120px] max-w-[210px] transition-colors hover:border-[var(--border-subtle)] ' +
  'focus:border-[var(--primary-color)] focus:ring-2 focus:ring-[var(--primary-subtle)]';
const ICON_BTN =
  'w-8 h-8 grid place-items-center rounded-lg border border-[var(--border-color)] ' +
  'text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] ' +
  'hover:border-[var(--primary-color)] hover:bg-[var(--primary-subtle)] active:scale-95';

export default function ConnectorPage() {
  const sessions = useAppStore((s) => s.sessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const selectSession = useAppStore((s) => s.selectSession);

  const models = useVTuberStore((s) => s.models);
  const modelsLoaded = useVTuberStore((s) => s.modelsLoaded);
  const fetchModels = useVTuberStore((s) => s.fetchModels);
  const fetchAssignment = useVTuberStore((s) => s.fetchAssignment);
  const assignModel = useVTuberStore((s) => s.assignModel);
  const assignedModelName = useVTuberStore((s) => (selectedSessionId ? s.assignments[selectedSessionId] : undefined));

  const { setTheme } = useTheme();
  const [booted, setBooted] = useState(false);

  // Pull the current assignment for the selected session so the model picker
  // shows what's actually bound (it was empty before). After this, the live
  // assignment stream (wired in fetchModels) keeps it in sync with the web +
  // overlay without polling.
  useEffect(() => {
    if (selectedSessionId) fetchAssignment(selectedSessionId);
  }, [selectedSessionId, fetchAssignment]);

  // Sync the connector's ?theme into the ThemeProvider store (module-load
  // already painted the class for no-flash; this keeps React state in sync).
  useEffect(() => {
    const resolved = resolveConnectorTheme();
    if (resolved) setTheme(resolved);
  }, [setTheme]);

  // token + initial data + session preselect (once).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const token = qs.get('token');
    if (token) setToken(token);
    const wantSession = qs.get('session');

    (async () => {
      await loadSessions();
      if (!modelsLoaded) fetchModels();
      // Honour ?session only if it still exists — a stale/deleted id would
      // otherwise block the auto-select below. The correction effect heals it.
      if (wantSession && useAppStore.getState().sessions.some((s) => s.session_id === wantSession)) {
        pickSession(wantSession);
      }
      setBooted(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-select a VTuber session AND correct a stale/invalid selection so the
  // panel + overlay self-heal onto a real VTuber.
  useEffect(() => {
    if (!booted) return;
    const cur = sessions.find((s) => s.session_id === selectedSessionId);
    if (cur?.role === 'vtuber') return; // already on a valid VTuber
    const v = sessions.find((s) => s.role === 'vtuber');
    if (v) pickSession(v.session_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, sessions, selectedSessionId]);

  // Select a session AND sync the floating overlay to it (connector only).
  const pickSession = (id: string) => {
    selectSession(id);
    window.connector?.windowControl.setOverlaySession(id);
  };

  const current = sessions.find((s) => s.session_id === selectedSessionId);
  const isVTuber = current?.role === 'vtuber';
  const vtuberSessions = sessions.filter((s) => s.role === 'vtuber');
  const sid = selectedSessionId ?? '';
  const isDesktop = typeof window !== 'undefined' && !!window.connector;
  const ready = isVTuber && !!current?.chat_room_id;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Toolbar — auto-height (min-h + flex-wrap) so it never clips when it
          wraps on a narrow window; one clean row at the default width. */}
      <header
        className="flex items-center gap-x-2.5 gap-y-2 px-3.5 py-2.5 min-h-[56px] shrink-0 flex-wrap border-b border-[var(--border-color)]"
        style={{ background: 'linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-primary) 140%)' }}
      >
        {/* session */}
        <div className="flex items-center gap-1.5">
          <span className="text-[0.62rem] font-semibold tracking-wider uppercase text-[var(--text-muted)]">세션</span>
          <div className="relative">
            <select className={TOOLBAR_SELECT} value={sid} onChange={(e) => pickSession(e.target.value)}>
              <option value="" disabled>세션 선택…</option>
              {vtuberSessions.map((s) => (
                <option key={s.session_id} value={s.session_id}>{s.session_name || s.session_id.slice(0, 8)}</option>
              ))}
            </select>
            <ChevronIcon className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
          </div>
          <button type="button" onClick={() => loadSessions()} title="세션 목록 새로고침" className={ICON_BTN}>
            <RefreshIcon className="w-4 h-4" />
          </button>
        </div>

        {/* model */}
        {isVTuber && (
          <div className="flex items-center gap-1.5">
            <span className="text-[0.62rem] font-semibold tracking-wider uppercase text-[var(--text-muted)]">모델</span>
            <div className="relative">
              <select
                className={TOOLBAR_SELECT}
                value={assignedModelName || ''}
                onChange={(e) => e.target.value && sid && assignModel(sid, e.target.value)}
              >
                <option value="" disabled>모델 선택…</option>
                {models.map((m) => (
                  <option key={m.name} value={m.name}>{m.display_name}</option>
                ))}
              </select>
              <ChevronIcon className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 ml-auto">
          {/* live status */}
          <span className="hidden sm:flex items-center gap-1.5 pr-1 text-[0.7rem] text-[var(--text-muted)]">
            <span className={`w-1.5 h-1.5 rounded-full ${ready ? 'bg-[var(--success-color)]' : 'bg-[var(--text-muted)]'}`}
              style={ready ? { boxShadow: '0 0 6px var(--success-color)' } : undefined} />
            {ready ? '연결됨' : '대기'}
          </span>
          {/* desktop-only controls */}
          {isDesktop && (
            <>
              <span className="w-px h-5 bg-[var(--border-color)] mx-0.5" aria-hidden />
              <button type="button" title="브라우저에서 Geny 서버 열기" onClick={() => window.connector?.windowControl.openExternal(window.location.origin)} className={ICON_BTN}>
                <ExternalIcon className="w-4 h-4" />
              </button>
              <button type="button" title="설정 (서버 · 계정 · 테마)" onClick={() => window.connector?.windowControl.openSettings()} className={ICON_BTN}>
                <GearIcon className="w-4 h-4" />
              </button>
              <button type="button" title="접속기 재시작" onClick={() => window.connector?.windowControl.restart()} className={ICON_BTN}>
                <PowerIcon className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Chat */}
      <div className="flex-1 min-h-0 bg-[var(--bg-secondary)]">
        {ready ? (
          <VTuberChatPanel sessionId={sid} roomId={current!.chat_room_id!} />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <div className="flex flex-col items-center gap-3 text-center max-w-[280px]">
              {!booted ? (
                <>
                  <div className="w-9 h-9 rounded-full border-[3px] border-[var(--bg-tertiary)] border-t-[var(--primary-color)] animate-spin" />
                  <div className="text-sm text-[var(--text-secondary)]">세션 불러오는 중…</div>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-2xl grid place-items-center bg-[var(--bg-tertiary)]/50 border border-[var(--border-color)] text-[var(--text-muted)]">
                    <MonitorIcon className="w-7 h-7" />
                  </div>
                  <div className="text-sm font-semibold text-[var(--text-primary)]">
                    {vtuberSessions.length === 0 ? 'VTuber 세션이 없습니다' : 'VTuber 세션을 선택하세요'}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] leading-relaxed">
                    {vtuberSessions.length === 0
                      ? '서버에서 VTuber 세션을 만든 뒤 위의 ↻ 로 새로고침하세요.'
                      : '위 세션 메뉴에서 대화할 VTuber를 고르면 채팅이 열립니다.'}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
