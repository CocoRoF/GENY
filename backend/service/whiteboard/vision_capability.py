"""
Vision capability heuristic — does the active model accept images
in its prompt content blocks?

Geny doesn't carry a first-class capability flag on a model yet, so
this module pattern-matches the model name. Wrong-direction failures
are well-tolerated:

  * False negative (we say "no vision" but the model can see):
    The Spotlight section degrades to a text-only placeholder
    plus eventually the P4 ``whiteboard_describe`` caption — the
    user still gets a useful response, just slower.
  * False positive (we say "yes vision" but the model can't see):
    The model receives image content blocks it doesn't understand
    and likely errors out or ignores them. Worse, but still
    contained — the share UX still shows success because the
    Spotlight item itself was staged fine.

Override knobs:
  * ``GENY_WHITEBOARD_VISION_CAPABLE_MODELS`` — comma-separated
    substrings; any match wins.
  * ``GENY_WHITEBOARD_DISABLE_VISION`` — force-off for everyone.
  * ``GENY_WHITEBOARD_FORCE_VISION`` — force-on for everyone.
"""

from __future__ import annotations

import os
from logging import getLogger
from typing import Optional

logger = getLogger(__name__)


# Substrings checked case-insensitively against the model name.
_DEFAULT_VISION_CAPABLE_PATTERNS: tuple[str, ...] = (
    # Anthropic — every Claude 3.x and later supports vision.
    "claude-3",
    "claude-opus",
    "claude-sonnet",
    "claude-haiku",
    # OpenAI vision-capable families.
    "gpt-4o",
    "gpt-4-vision",
    "gpt-4-turbo",
    "gpt-5",
    "o1-vision",
    # Google.
    "gemini-1.5",
    "gemini-2",
    "gemini-pro-vision",
)


def _custom_patterns() -> tuple[str, ...]:
    raw = os.environ.get("GENY_WHITEBOARD_VISION_CAPABLE_MODELS", "").strip()
    if not raw:
        return ()
    return tuple(p.strip().lower() for p in raw.split(",") if p.strip())


def is_vision_capable(model_name: Optional[str]) -> bool:
    """Best-effort vision check for ``model_name``.

    ``None`` / empty returns ``False`` (safer default — assume the
    minimal capability rather than over-promise).
    """
    if os.environ.get("GENY_WHITEBOARD_DISABLE_VISION", "").lower() in (
        "1",
        "true",
        "yes",
    ):
        return False
    if os.environ.get("GENY_WHITEBOARD_FORCE_VISION", "").lower() in (
        "1",
        "true",
        "yes",
    ):
        return True
    if not model_name:
        return False
    needle = model_name.lower()
    if any(p in needle for p in _custom_patterns()):
        return True
    return any(p in needle for p in _DEFAULT_VISION_CAPABLE_PATTERNS)
