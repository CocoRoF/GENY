"""Canonical emotion-tag vocabulary — single source of truth.

One module for all tag-related concerns so three former consumers
(the emitter's strip regex, the display sanitizer's whitelist, and
the prompt template's instruction list) can't drift apart again:

- Which tags the VTuber prompt is allowed to emit.
- How each tag maps into the 6-dim ``MoodVector`` axes and optional
  ``Bond`` deltas (used by :class:`AffectTagEmitter` to translate a
  ``[tag:strength]`` occurrence into a ``MutationBuffer`` entry).
- Which tags the display sanitizer strips from user-visible text.

Design notes
------------

- **stdlib-only.** No pipeline / numpy / executor imports. Both
  ``service.emit.affect_tag_emitter`` and
  ``service.utils.text_sanitizer`` must be importable from this
  module without creating a cycle.
- **Coefficient table, not hard-coded deltas.** The emitter owns the
  final numeric scaling (``MOOD_ALPHA``, bond constants); we publish
  per-tag *unit coefficients* here. The emitter multiplies by its
  scale factors at apply time, which keeps this table readable and
  makes it safe to re-tune scaling without touching the taxonomy.
- **Permissive aliasing.** ``[excited]`` and ``[excitement]`` both
  map to the excitement axis. LLMs routinely produce both forms; we
  normalize by listing them as separate keys with identical targets.

Keep this file in lockstep with ``backend/prompts/vtuber.md`` —
the prompt should list exactly the tags declared here.
"""

from __future__ import annotations

from typing import Dict, Final, Tuple

__all__ = [
    "MOOD_AXES",
    "AFFECT_TAG_MAPPING",
    "RECOGNIZED_TAGS",
    "coefficients_for",
]


#: The 6 canonical mood axes. Order matches :class:`MoodVector` field
#: order in ``service.state.schema.mood``.
MOOD_AXES: Final[Tuple[str, ...]] = (
    "joy",
    "sadness",
    "anger",
    "fear",
    "calm",
    "excitement",
)


#: Tag → { mutation_path : coefficient-at-strength-1.0 }.
#:
#: Coefficients are *unitless multipliers* applied by
#: :class:`AffectTagEmitter` at emission time against its
#: ``MOOD_ALPHA`` (for ``mood.*``) and bond constants (for ``bond.*``).
#: A coefficient of 1.0 reproduces the pre-X7 behavior for the original
#: six tags (joy/sadness/anger/fear/calm/excitement).
AFFECT_TAG_MAPPING: Final[Dict[str, Dict[str, float]]] = {
    # ── Primary 6: 1:1 axis mapping — MUST preserve pre-X7 magnitudes
    # so existing tests and tuned behavior stay exact. New tags below
    # use sub-1.0 coefficients to avoid over-contributing.
    "joy":        {"mood.joy": 1.0, "bond.affection": 1.0},
    "sadness":    {"mood.sadness": 1.0},
    "anger":      {"mood.anger": 1.0, "bond.trust": 1.0},
    "fear":       {"mood.fear": 1.0, "bond.trust": 1.0},
    "calm":       {"mood.calm": 1.0, "bond.affection": 1.0},
    "excitement": {"mood.excitement": 1.0},

    # ── Aliases of the primary 6 ───────────────────────────────────
    "excited":    {"mood.excitement": 1.0},

    # ── Surprise / curiosity family ────────────────────────────────
    "surprise":     {"mood.excitement": 0.6, "mood.fear": 0.3},
    "wonder":       {"mood.excitement": 0.4, "mood.calm": 0.3, "mood.joy": 0.2},
    "amazement":    {"mood.excitement": 0.7, "mood.joy": 0.3},
    "curious":      {"mood.excitement": 0.5, "mood.joy": 0.2},
    "curiosity":    {"mood.excitement": 0.5, "mood.joy": 0.2},

    # ── Positive spectrum ──────────────────────────────────────────
    "satisfaction": {"mood.joy": 0.5, "mood.calm": 0.4, "bond.affection": 0.3},
    "proud":        {"mood.joy": 0.6, "mood.excitement": 0.2, "bond.affection": 0.4},
    "grateful":     {"mood.joy": 0.5, "mood.calm": 0.3, "bond.affection": 0.5},
    "playful":      {"mood.joy": 0.5, "mood.excitement": 0.4, "bond.affection": 0.3},
    "confident":    {"mood.joy": 0.4, "mood.calm": 0.3},
    "amused":       {"mood.joy": 0.6, "mood.excitement": 0.2},
    "tender":       {"mood.calm": 0.5, "mood.joy": 0.3, "bond.affection": 0.4},
    "warmth":       {"mood.calm": 0.5, "mood.joy": 0.3, "bond.affection": 0.3},
    "love":         {"mood.joy": 0.7, "mood.calm": 0.3, "bond.affection": 0.7},
    "smirk":        {"mood.joy": 0.3, "mood.excitement": 0.2},

    # ── Negative spectrum (milder than primary 4) ──────────────────
    "disgust":      {"mood.anger": 0.5, "mood.sadness": 0.3},
    "concerned":    {"mood.fear": 0.4, "mood.sadness": 0.3},
    "shy":          {"mood.fear": 0.3, "mood.calm": 0.2},

    # ── Neutral / reflective ───────────────────────────────────────
    "neutral":      {"mood.calm": 0.3},
    "thoughtful":   {"mood.calm": 0.5, "mood.sadness": 0.1},
}


#: Tuple of all tag names known to the taxonomy. Used by the emitter
#: regex and by the display sanitizer whitelist. Insertion order is
#: preserved (Python 3.7+ dict semantics) so the tag list in the
#: prompt template can be generated deterministically.
RECOGNIZED_TAGS: Final[Tuple[str, ...]] = tuple(AFFECT_TAG_MAPPING.keys())


def coefficients_for(tag: str) -> Dict[str, float]:
    """Return the coefficient map for ``tag`` (case-insensitive).

    Unknown tags return an empty dict — the emitter uses this as a
    signal that the tag is still strippable from display but should
    not emit any mutation.
    """
    return AFFECT_TAG_MAPPING.get(tag.lower(), {})
