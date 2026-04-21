"""Display-layer sanitization for agent output.

Strips the three kinds of special markers that agents emit but that
should never reach a user-visible surface (chat room, TTS, UI):

* Routing / system prefixes — ``[THINKING_TRIGGER]``,
  ``[SUB_WORKER_RESULT]``, ``[DELEGATION_REQUEST|RESULT]``, etc.
  These are protocol tags consumed by the classifier / router.
* Emotion tags — ``[joy]``, ``[surprise]``, ``[smirk]``, …
  emitted deliberately by VTuber prompts and consumed by the
  avatar layer (``EmotionExtractor``). Not for humans.
* Reasoning blocks — ``<think>...</think>`` emitted by reasoning
  models.

Kept free of agent/session state so it's safe to call from any
display sink, including streaming accumulation where the input may
be a partial, still-growing string (a regex ``sub`` over the whole
accumulated buffer correctly strips complete tags and leaves an
incomplete trailing tag in place until the next token completes it).
"""

from __future__ import annotations

import re

# Exported so consumers (TTS sanitizer, future plugins) can extend
# the routing-prefix set without duplicating the master list.
SYSTEM_TAG_PATTERN = re.compile(
    r"\["
    r"(?:THINKING_TRIGGER(?::\w+)?|"
    r"autonomous_signal:[^]]*|"
    r"DELEGATION_REQUEST|"
    r"DELEGATION_RESULT|"
    r"SUB_WORKER_RESULT|"
    r"CLI_RESULT|"
    r"ACTIVITY_TRIGGER(?::\w+)?|"
    r"SILENT)"
    r"\]\s*",
    re.IGNORECASE,
)

# Canonical emotion labels. Mirrors ``tts_controller._EMOTION_TAGS``
# and the Live2D model emotionMap. Update in lockstep if new labels
# are added to the VTuber prompt vocabulary.
EMOTION_TAGS = (
    "neutral", "joy", "anger", "disgust", "fear", "smirk",
    "sadness", "surprise", "warmth", "curious", "calm",
    "excited", "shy", "proud", "grateful", "playful",
    "confident", "thoughtful", "concerned", "amused", "tender",
)
EMOTION_TAG_PATTERN = re.compile(
    r"\[(?:" + "|".join(EMOTION_TAGS) + r")\]\s*",
    re.IGNORECASE,
)

THINK_BLOCK_PATTERN = re.compile(
    r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE
)
# Open-ended <think> with no closer (the LLM didn't emit </think>
# yet, e.g. mid-stream). Everything from <think> onward is dropped.
THINK_OPEN_PATTERN = re.compile(r"<think>.*", re.DOTALL | re.IGNORECASE)

_WHITESPACE_COLLAPSE = re.compile(r"\s{2,}")


def sanitize_for_display(text: str | None) -> str:
    """Strip routing / emotion / think markers; collapse whitespace.

    Safe on ``None`` and empty input — returns ``""`` so callers can
    concatenate / length-check without guarding.

    Unknown bracketed tokens (e.g. ``[note]``, ``[INBOX from X]``)
    are preserved; only the whitelisted routing prefixes and canonical
    emotion labels are removed. This keeps legitimate user text that
    happens to contain brackets intact.
    """
    if not text:
        return ""
    text = THINK_BLOCK_PATTERN.sub("", text)
    text = THINK_OPEN_PATTERN.sub("", text)
    text = SYSTEM_TAG_PATTERN.sub("", text)
    text = EMOTION_TAG_PATTERN.sub("", text)
    return _WHITESPACE_COLLAPSE.sub(" ", text).strip()
