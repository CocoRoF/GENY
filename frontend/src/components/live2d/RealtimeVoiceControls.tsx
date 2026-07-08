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
  const partial = useVTuberStore((s) => s.realtimePartial);

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={toggle}
        title={
          on
            ? '실시간 음성 대화 끄기 (핸즈프리)'
            : '실시간 음성 대화 켜기 — 말하면 바로 채팅으로 입력됩니다'
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
        <span>대화</span>
      </button>

      {on && (
        <span
          className={`flex items-center gap-1 px-2 py-0.5 text-[0.6875rem] rounded-full max-w-[220px] truncate transition-colors ${
            listening
              ? 'bg-[rgba(34,197,94,0.12)] text-green-400 border border-green-500/30'
              : 'bg-[rgba(255,255,255,0.03)] text-[var(--text-muted,#94a3b8)] border border-white/5'
          }`}
          title={partial || (listening ? '듣는 중…' : '대기 중 — 말씀하시면 인식합니다')}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              listening ? 'bg-green-400 animate-pulse' : 'bg-slate-500'
            }`}
          />
          <span className="truncate">
            {partial ? partial : listening ? '듣는 중…' : '대기 중'}
          </span>
        </span>
      )}
    </div>
  );
}
