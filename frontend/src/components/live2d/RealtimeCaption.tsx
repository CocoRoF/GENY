'use client';

/**
 * RealtimeCaption — the persistent live caption for hands-free voice.
 *
 * While the "대화" (hands-free) mode is on, this shows what the backend is
 * hearing IN REAL TIME as the user speaks: the settled prefix (transcribed
 * twice → stable) is solid, the still-changing tail is faded, so the caption
 * grows smoothly instead of flickering. This is the "you can SEE your input"
 * feedback that was missing. It clears when the utterance finishes (the final
 * text then appears as a normal chat message).
 *
 * Rendered as a bottom overlay on the avatar canvas so it's large and obvious.
 */

import { useVTuberStore } from '@/store/useVTuberStore';

export default function RealtimeCaption() {
  const on = useVTuberStore((s) => s.realtimeVoiceEnabled);
  const listening = useVTuberStore((s) => s.realtimeListening);
  const partial = useVTuberStore((s) => s.realtimePartial);
  const stable = useVTuberStore((s) => s.realtimePartialStable);

  if (!on) return null;
  // Show while the mic is live (listening) or there's interim text to display.
  if (!listening && !partial) return null;

  const stableText = partial.slice(0, Math.max(0, Math.min(stable, partial.length)));
  const tailText = partial.slice(stableText.length);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <div className="max-w-[92%] rounded-2xl bg-black/65 backdrop-blur-sm px-4 py-2.5 shadow-lg border border-white/10">
        {partial ? (
          <p className="text-[0.95rem] leading-snug text-center break-words">
            <span className="text-white">{stableText}</span>
            <span className="text-white/45">{tailText}</span>
            <span className="ml-0.5 inline-block w-0.5 h-4 align-middle bg-green-400 animate-pulse rounded-full" />
          </p>
        ) : (
          <p className="flex items-center gap-2 text-[0.85rem] text-white/70">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            듣는 중…
          </p>
        )}
      </div>
    </div>
  );
}
