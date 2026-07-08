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
