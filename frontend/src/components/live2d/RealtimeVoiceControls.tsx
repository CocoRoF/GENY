'use client';

/**
 * RealtimeVoiceControls — the "대화" (hands-free realtime voice) toggle + a
 * live listening indicator, so the user can SEE the voice input working.
 *
 * Mirrors STTControls visually. When realtime is on and the backend VAD is
 * hearing speech, it shows a pulsing "듣는 중…" pill with the interim
 * transcript — the feedback that was missing (was the mic capturing? is it
 * transcribing?). The finished transcript then lands in the chat as a
 * normal user message (see RealtimeVoiceDriver).
 */

import { useVTuberStore } from '@/store/useVTuberStore';

export default function RealtimeVoiceControls() {
  const on = useVTuberStore((s) => s.realtimeVoiceEnabled);
  const toggle = useVTuberStore((s) => s.toggleRealtimeVoice);
  const listening = useVTuberStore((s) => s.realtimeListening);
  const captions = useVTuberStore((s) => s.realtimePartialsEnabled);
  const setCaptions = useVTuberStore((s) => s.setRealtimePartialsEnabled);

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={toggle}
        title={
          on
            ? '핸즈프리 음성 대화 끄기'
            : '핸즈프리 음성 대화 켜기 — 말하면 실시간 자막이 뜨고, 멈추면 바로 채팅으로 입력됩니다'
        }
        className={`flex items-center gap-1 px-2 py-0.5 text-[0.6875rem] rounded-full border cursor-pointer transition-all duration-150 ${
          on
            ? 'bg-[rgba(139,92,246,0.15)] text-violet-400 border-violet-500/40'
            : 'bg-[rgba(255,255,255,0.03)] text-[var(--text-muted,#94a3b8)] border-white/10'
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
        </svg>
        <span>{on ? '핸즈프리 켜짐' : '핸즈프리'}</span>
        {on && (
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              listening ? 'bg-green-400 animate-pulse' : 'bg-violet-400/50'
            }`}
          />
        )}
      </button>

      {on && (
        <button
          onClick={() => setCaptions(!captions)}
          title={
            captions
              ? '실시간 자막 끄기 (말하는 중 인식 표시)'
              : '실시간 자막 켜기 — 말하는 동안 인식된 내용을 보여줍니다'
          }
          className={`flex items-center gap-1 px-2 py-0.5 text-[0.6875rem] rounded-full border cursor-pointer transition-all duration-150 ${
            captions
              ? 'bg-[rgba(34,197,94,0.12)] text-green-400 border-green-500/30'
              : 'bg-[rgba(255,255,255,0.03)] text-[var(--text-muted,#94a3b8)] border-white/10'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
          </svg>
          <span>자막</span>
        </button>
      )}
    </div>
  );
}
