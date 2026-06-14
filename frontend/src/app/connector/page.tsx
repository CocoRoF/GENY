'use client';

/**
 * /connector — the desktop connector's control panel (loaded in the control
 * window). Reuses the dashboard's proven control components, no porting:
 * session picker, avatar-model picker, TTS / STT / screen-observation toggles,
 * and the full chat panel. A normal browser can open it too (when logged in);
 * inside the Electron connector it also drives the floating overlay's session
 * via window.connector (preload).
 *
 * Query: ?token (→localStorage), ?session (preselect).
 */

import { useEffect, useState } from 'react';
import { setToken } from '@/lib/authApi';
import { useAppStore } from '@/store/useAppStore';
import { useVTuberStore } from '@/store/useVTuberStore';
import VTuberChatPanel from '@/components/live2d/VTuberChatPanel';

// CRITICAL: this is the chat window, a SEPARATE renderer process from the avatar
// overlay. If TTS ran here too, audio would play twice (two AudioManagers). Voice
// (TTS/STT) and screen-scan live ONLY in the avatar window; here we force TTS off
// at module load (before any message can arrive) so chat is silent view+send.
useVTuberStore.setState({ ttsEnabled: false });

export default function ConnectorPage() {
  const sessions = useAppStore((s) => s.sessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const selectSession = useAppStore((s) => s.selectSession);

  const models = useVTuberStore((s) => s.models);
  const modelsLoaded = useVTuberStore((s) => s.modelsLoaded);
  const fetchModels = useVTuberStore((s) => s.fetchModels);
  const assignModel = useVTuberStore((s) => s.assignModel);
  const assignedModelName = useVTuberStore((s) => (selectedSessionId ? s.assignments[selectedSessionId] : undefined));

  const [booted, setBooted] = useState(false);

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

  // Auto-select a VTuber session AND correct a stale/invalid selection (e.g. a
  // ?session preselect or persisted id pointing at a deleted/old session, or a
  // non-VTuber session) so the panel + overlay self-heal onto a real VTuber
  // instead of getting stuck on "VTuber 세션을 선택하세요".
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

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Top bar: session + model pickers + voice/screen controls */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-[0.7rem] text-[var(--text-muted)] font-medium">세션</label>
          <select
            className="px-2 py-1 text-[0.75rem] rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] outline-none cursor-pointer min-w-[150px]"
            value={sid}
            onChange={(e) => pickSession(e.target.value)}
          >
            <option value="" disabled>세션 선택…</option>
            {vtuberSessions.map((s) => (
              <option key={s.session_id} value={s.session_id}>
                {s.session_name || s.session_id.slice(0, 8)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => loadSessions()}
            title="세션 목록 새로고침"
            className="px-2 py-1 text-[0.8rem] rounded-md border border-[var(--border-color)] text-[var(--text-muted)] hover:border-[var(--primary-color)] hover:text-[var(--primary-color)]"
          >
            ↻
          </button>
        </div>

        {isVTuber && (
          <div className="flex items-center gap-2">
            <label className="text-[0.7rem] text-[var(--text-muted)] font-medium">모델</label>
            <select
              className="px-2 py-1 text-[0.75rem] rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] outline-none cursor-pointer min-w-[150px]"
              value={assignedModelName || ''}
              onChange={(e) => e.target.value && sid && assignModel(sid, e.target.value)}
            >
              <option value="" disabled>모델 선택…</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center gap-3 ml-auto">
          {/* Voice (TTS/STT) + screen-scan live in the AVATAR window only — keeping
              them out of here prevents double audio. This window is chat-only. */}
          {/* Settings (server URL / account / auto-update) — desktop only. */}
          {typeof window !== 'undefined' && window.connector && (
            <>
              <button
                type="button"
                title="설정 (서버/계정/자동업데이트)"
                onClick={() => window.connector?.windowControl.openSettings()}
                className="px-2 py-1 text-[0.75rem] rounded-md border border-[var(--border-color)] text-[var(--text-muted)] hover:border-[var(--primary-color)] hover:text-[var(--primary-color)]"
              >
                ⚙ 설정
              </button>
              <button
                type="button"
                title="접속기 재시작"
                onClick={() => window.connector?.windowControl.restart()}
                className="px-2 py-1 text-[0.75rem] rounded-md border border-[var(--border-color)] text-[var(--text-muted)] hover:border-[var(--primary-color)] hover:text-[var(--primary-color)]"
              >
                ↻ 재시작
              </button>
            </>
          )}
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 min-h-0 bg-[var(--bg-secondary)]">
        {isVTuber && current?.chat_room_id ? (
          <VTuberChatPanel sessionId={sid} roomId={current.chat_room_id} />
        ) : (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            {!booted
              ? '세션 불러오는 중…'
              : vtuberSessions.length === 0
                ? '서버에 VTuber 세션이 없습니다.'
                : 'VTuber 세션을 선택하세요.'}
          </div>
        )}
      </div>
    </div>
  );
}
