"""
Audio inbox noise pruning — follow-up to V1/V2.

Auto-STT mode (``source="vtuber_stt_stream"``) hands every VAD-detected
utterance to the inbox. The VAD is intentionally permissive — better
to over-trigger than miss a sentence — which means throat clears,
mouse clicks, room noise spikes etc. land as audio captures too. Once
Whisper transcribes those, the result is either empty, a single
character (``-``, ``.``), or pure whitespace.

This module decides which of those are confidently noise and prunes
the corresponding note + attachment. Pruning is **only** applied to
captures from the auto-STT stream — manual ``microphone_record`` and
``file_drop`` captures are user-intentional and never auto-deleted.

Public surface:
  * :func:`is_noise_transcript` — pure predicate, used by both the
    W2 hook (decide at capture time) and the V1 backfill loop
    (decide on already-stored notes).
  * :func:`extract_existing_transcript` — parse the
    ``> **Transcript (lang):** …`` block back out of a note body so
    the backfill loop can re-evaluate previously-filled notes.
  * :func:`prune_audio_note` — best-effort delete of note + attachment.
"""

from __future__ import annotations

import re
from logging import getLogger
from typing import Any, Optional

logger = getLogger(__name__)


# Sources that the pruner is allowed to delete from. Manual W3
# (``microphone_record``) + drag-drop (``file_drop``) are explicitly
# excluded — those captures represent a deliberate user click and
# must never disappear from the inbox even if the transcript is
# silent.
AUTO_STT_SOURCES: frozenset[str] = frozenset({"vtuber_stt_stream"})


# What counts as a "real" character: ASCII word chars (letters /
# digits / underscore) plus the standard CJK ranges (Hangul,
# Hangul-Jamo, CJK Unified Ideographs, Hiragana, Katakana). Punctuation,
# whitespace, dashes, ellipses, and lone emoji are filtered out so a
# transcript of ``-`` / ``.`` / ``...`` / ``..?`` all read as "no
# real content".
_MEANINGFUL_CHAR_RE = re.compile(
    r"[\w가-힯㄰-㆏一-鿿぀-ゟ゠-ヿ]",
    re.UNICODE,
)


# Common filler / hesitation tokens that Whisper sometimes pops out
# when the audio is non-speech (cough, mouse click, room hum). The
# meaningful-char count alone won't catch "uh" (2 chars) or "음"
# (1 char — Korean would already prune that one) but the user sees
# them as noise either way. Match is case-insensitive after we strip
# trailing/leading punctuation.
_FILLER_TOKENS: frozenset[str] = frozenset({
    # English
    "uh", "uhh", "uhhh", "um", "umm", "ummm", "uhm",
    "ah", "ahh", "ahhh", "oh", "ohh", "ohhh",
    "mm", "mmm", "mmmm", "hm", "hmm", "hmmm",
    "huh", "duh", "meh", "yo",
    "er", "err", "erm",
    # Korean (Hangul filler vocalizations)
    "어", "어어", "음", "음음", "흠", "흐음",
    "아", "아아", "오", "오오", "에", "에이",
    "응", "엉", "헐",
    # Japanese fillers
    "うん", "ううん", "あー", "あ", "えー", "えーと", "んー",
})


def _normalize_for_filler_check(text: str) -> str:
    """Strip surrounding punctuation/whitespace + lowercase so
    ``"Uh."``, ``"uh ?"``, ``"  uh  "`` all collapse to ``"uh"``.

    Keeps inner characters intact so ``"uh huh"`` (two tokens) doesn't
    collapse to ``"uhhuh"`` and accidentally match a filler.
    """
    cleaned = re.sub(r"^[\s\.,!?;:\-—…\"']+", "", text)
    cleaned = re.sub(r"[\s\.,!?;:\-—…\"']+$", "", cleaned)
    return cleaned.lower()


def _is_filler_only(text: str) -> bool:
    """True when the entire stripped transcript is a single filler
    token (case-insensitive, surrounding punctuation ignored)."""
    normalized = _normalize_for_filler_check(text)
    if not normalized:
        return False
    return normalized in _FILLER_TOKENS


# Tunables — kept module-level so a future config knob can swap them
# without touching the predicate signature.
MIN_MEANINGFUL_CHARS = 2
MIN_DURATION_SECONDS = 0.4


def is_noise_transcript(
    text: Optional[str],
    duration_seconds: Optional[float] = None,
) -> bool:
    """Return True when the transcript should be treated as noise.

    Conservative — three independent signals trigger the verdict:

      1. Empty / whitespace-only / fewer than ``MIN_MEANINGFUL_CHARS``
         word-or-CJK characters. Catches ``"-"`` / ``"..."`` / ``"."``
         style Whisper fallbacks.
      2. The full stripped text matches a known filler token
         (``"uh"`` / ``"um"`` / ``"hmm"`` / ``"어"`` / ``"음"`` etc.).
         Catches the case Whisper does recognise non-speech as a
         hesitation marker — the user still sees these as noise.
      3. Audio duration was measured AND it's under
         ``MIN_DURATION_SECONDS``. Sub-400 ms clips on the VAD
         barely contain anything; even with a meaningful transcript
         they're almost always misfires.
    """
    if text is None:
        return True
    stripped = text.strip()
    if not stripped:
        return True
    if _is_filler_only(stripped):
        return True
    meaningful = _MEANINGFUL_CHAR_RE.findall(stripped)
    if len(meaningful) < MIN_MEANINGFUL_CHARS:
        return True
    if (
        duration_seconds is not None
        and duration_seconds > 0
        and duration_seconds < MIN_DURATION_SECONDS
    ):
        return True
    return False


# Match the block format prepended by the W2 hook + V1 backfill:
#   ``> **Transcript (lang):** body text\n\n``
# The (lang) part can be anything Whisper / vLLM returns (``en`` /
# ``ko`` / ``ja`` / ``auto`` / etc.). The body runs to the first
# blank line so a multi-paragraph transcript still reads cleanly.
_TRANSCRIPT_BLOCK_RE = re.compile(
    r"^\s*>\s*\*\*Transcript\s*\(([^)]*)\)\s*:\*\*\s*(.*?)\s*(?:\n\s*\n|\Z)",
    re.DOTALL | re.MULTILINE,
)


def extract_existing_transcript(body: str) -> Optional[str]:
    """Return the transcript text from a draft note body, or ``None``
    when no transcript block is present.

    Used by the V1 backfill loop to re-evaluate notes that already
    have a transcript — if the existing text is noise, we still
    want to prune it on a later pass (catches notes that were
    filled before the pruner shipped).
    """
    if not body:
        return None
    m = _TRANSCRIPT_BLOCK_RE.search(body)
    if not m:
        return None
    return m.group(2).strip()


def should_prune_for_source(source: Optional[str]) -> bool:
    """Whether a capture from *source* is eligible for auto-prune.

    Kept separate from :func:`is_noise_transcript` so callers can
    skip the (cheap) noise check entirely when the source isn't
    eligible — the predicate is correct either way, but it's clearer
    to short-circuit at the caller.
    """
    if not source:
        return False
    return source in AUTO_STT_SOURCES


def prune_audio_note(
    mgr: Any,
    draft_note_filename: str,
    attachment_path: Optional[str],
) -> bool:
    """Hard-delete a noisy audio inbox note plus its attachment.

    Best-effort:
      * Note delete failure → returns False, attachment delete still
        attempted.
      * Attachment delete failure → logged at debug, returns whatever
        the note delete returned.

    Returns True iff the note was successfully removed from the vault.
    """
    deleted_note = False
    try:
        deleted_note = bool(mgr.delete_note(draft_note_filename))
    except Exception:  # noqa: BLE001
        logger.warning(
            "audio_prune: delete_note(%s) failed",
            draft_note_filename, exc_info=True,
        )
    if attachment_path:
        try:
            mgr.delete_attachment(attachment_path)
        except Exception:  # noqa: BLE001
            logger.debug(
                "audio_prune: delete_attachment(%s) failed",
                attachment_path, exc_info=True,
            )
    return deleted_note
