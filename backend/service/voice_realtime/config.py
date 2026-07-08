"""Env-driven tunables for the realtime voice loop.

Kept as environment overrides (the same lightweight pattern
``screen_observation.py`` uses) rather than a ConfigManager card — these
are latency/quality knobs an operator tunes per deployment, not per-user
settings. All have sensible defaults; nothing here is required.
"""

from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (ValueError, TypeError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (ValueError, TypeError):
        return default


def sentence_min_chars() -> int:
    """A completed sentence shorter than this is held and merged forward,
    so TTS doesn't fire on choppy one-word clips. Lower = snappier but
    more fragmented; higher = smoother but later first audio."""
    return _int("GENY_RT_SENTENCE_MIN_CHARS", 12)


def sentence_max_chars() -> int:
    """A run-on line with no terminator is force-flushed to TTS past this
    length so a long unpunctuated reply still starts speaking."""
    return _int("GENY_RT_SENTENCE_MAX_CHARS", 180)


def stream_poll_seconds() -> float:
    """How often the turn loop drains STREAM log tokens. Matches the chat
    controller's 50 ms token-streaming cadence."""
    return _float("GENY_RT_STREAM_POLL_S", 0.05)


def turn_hard_timeout_seconds() -> float:
    """Backstop cap on one turn's loop (the executor has its own timeout)."""
    return _float("GENY_RT_TURN_TIMEOUT_S", 180.0)


# ── Server-side streaming VAD (input_mode="server_vad") ──────────────
#
# These control how the server decides a spoken turn is over when audio is
# streamed continuously (as opposed to client_vad, where the browser sends
# a complete utterance blob). Defaults mirror the reference speech-to-speech
# tuning (thresh 0.5, ~250 ms min speech, ~700 ms trailing silence).


def stt_only_default() -> bool:
    """When true (default), the realtime WS does STT ONLY — it emits the
    final transcript and lets the frontend post it to the visible chat room
    (so the spoken message + persona reply appear in the chat like typing,
    and TTS plays through the existing per-sentence path). When false, the
    session runs the persona turn itself and streams reply audio over the
    realtime WS (invisible to the chat window)."""
    return os.environ.get("GENY_RT_STT_ONLY", "1").strip().lower() in (
        "1", "true", "yes", "on",
    )


def default_input_mode() -> str:
    """'server_vad' (stream raw PCM, server detects end-of-speech) or
    'client_vad' (browser VAD sends complete utterances). A per-connection
    ``start`` message overrides this default."""
    mode = os.environ.get("GENY_RT_INPUT_MODE", "server_vad").strip().lower()
    return mode if mode in ("server_vad", "client_vad") else "server_vad"


def vad_threshold() -> float:
    """Speech probability at/above which a frame counts as speech."""
    return _float("GENY_RT_VAD_THRESHOLD", 0.5)


def vad_min_speech_ms() -> int:
    """Speech must sustain this long to open a turn (filters clicks)."""
    return _int("GENY_RT_VAD_MIN_SPEECH_MS", 250)


def vad_min_silence_ms() -> int:
    """Trailing silence this long closes a turn — the end-of-speech gate.
    Lower = snappier turn-taking but risks cutting mid-sentence pauses."""
    return _int("GENY_RT_VAD_MIN_SILENCE_MS", 700)


def vad_speech_pad_ms() -> int:
    """Audio kept before the trigger so the leading sound isn't clipped."""
    return _int("GENY_RT_VAD_SPEECH_PAD_MS", 120)


def vad_max_utterance_ms() -> int:
    """Force end-of-speech after this long even without a silence gap, so a
    non-stop talker still gets a turn."""
    return _int("GENY_RT_VAD_MAX_UTTERANCE_MS", 30000)


# ── Progressive partial transcripts (live "you're saying…" captions) ─
#
# OFF by default: it re-transcribes the growing utterance every interval
# via the SAME Whisper GPU the persona uses, so it competes for the single
# GPU. Turn on only when live user captions matter more than that budget.


def partial_transcripts_enabled() -> bool:
    return os.environ.get("GENY_RT_PARTIAL_TRANSCRIPTS", "0").strip().lower() in (
        "1", "true", "yes", "on",
    )


def partial_interval_ms() -> int:
    """Minimum gap between interim transcriptions of the open utterance."""
    return _int("GENY_RT_PARTIAL_INTERVAL_MS", 900)
