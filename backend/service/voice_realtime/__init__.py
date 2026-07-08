"""Realtime voice conversation pipeline (additive — 2026-07).

A full-duplex voice loop that layers ON TOP of Geny's existing stack
without modifying any of it:

  mic (frontend JS VAD) → utterance
    → whisper_client.atranscribe          (existing STT container)
    → execute_command + STREAM log poll    (existing persona/memory/tools)
    → EmotionExtractor + sentence split     (existing emotion system)
    → tts_service.speak_sentences           (existing OmniVoice + fallback)
    → audio deltas over WebSocket → audioManager (existing playback + lipsync)

The reference Hugging Face ``speech-to-speech`` pipeline was the design
guide; the turn-taking / barge-in orchestration is re-written here in
Geny's asyncio idiom rather than ported. See
``/home/workspace/geny-voice-pipeline-review.md``.

Nothing here is imported by the existing chat / TTS / STT paths — a new
WebSocket route (:mod:`ws.voice_realtime_stream`) is the only entry point.
"""

from .sentence import IncrementalSentenceExtractor
from .session import RealtimeVoiceSession

__all__ = ["IncrementalSentenceExtractor", "RealtimeVoiceSession"]
