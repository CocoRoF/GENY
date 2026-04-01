'use client';

import { useVTuberStore } from '@/store/useVTuberStore';
import { useI18n } from '@/lib/i18n';

/**
 * AudioControls — TTS ON/OFF 토글, 볼륨 슬라이더, 재생 상태 표시
 *
 * VTuberTab 상단 바에 배치하여 TTS 제어 UI를 제공합니다.
 */
export default function AudioControls({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const ttsEnabled = useVTuberStore((s) => s.ttsEnabled);
  const ttsVolume = useVTuberStore((s) => s.ttsVolume);
  const isSpeaking = useVTuberStore((s) => s.ttsSpeaking[sessionId] ?? false);
  const toggleTTS = useVTuberStore((s) => s.toggleTTS);
  const setTTSVolume = useVTuberStore((s) => s.setTTSVolume);
  const stopSpeaking = useVTuberStore((s) => s.stopSpeaking);

  return (
    <div className="flex items-center gap-2">
      {/* TTS 토글 버튼 */}
      <button
        onClick={() => {
          if (isSpeaking) stopSpeaking(sessionId);
          toggleTTS();
        }}
        className={`flex items-center gap-1 px-2 py-0.5 text-[0.6875rem] rounded-full border cursor-pointer transition-all duration-150 ${
          ttsEnabled
            ? isSpeaking
              ? 'bg-[rgba(34,197,94,0.1)] text-green-500 border-green-500/30'
              : 'bg-[rgba(59,130,246,0.1)] text-[var(--primary-color)] border-[var(--primary-color)]/30'
            : 'bg-transparent text-[var(--text-muted)] border-[var(--border-color)] opacity-60'
        }`}
        title={ttsEnabled ? (t('tts.clickToDisable') ?? 'Click to disable TTS') : (t('tts.clickToEnable') ?? 'Click to enable TTS')}
      >
        {/* Speaker icon */}
        {ttsEnabled ? (
          <svg className={`w-3.5 h-3.5 ${isSpeaking ? 'animate-pulse' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        )}
        <span>TTS</span>
      </button>

      {/* 볼륨 슬라이더 (TTS 활성 시만 표시) */}
      {ttsEnabled && (
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={ttsVolume}
          onChange={(e) => setTTSVolume(parseFloat(e.target.value))}
          className="w-16 h-1 accent-[var(--primary-color)] cursor-pointer"
          title={`${t('tts.volume') ?? 'Volume'}: ${Math.round(ttsVolume * 100)}%`}
        />
      )}

      {/* 재생 중 중지 버튼 */}
      {isSpeaking && (
        <button
          onClick={() => stopSpeaking(sessionId)}
          className="flex items-center gap-0.5 px-1.5 py-0.5 text-[0.625rem] rounded-full bg-red-500/10 text-red-500 border border-red-500/20 cursor-pointer hover:bg-red-500/20 transition-colors"
          title={t('tts.stop') ?? 'Stop speaking'}
        >
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
      )}
    </div>
  );
}
