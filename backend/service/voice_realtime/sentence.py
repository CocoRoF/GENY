"""Incremental sentence extraction from a growing text stream.

The persona reply arrives token-by-token (STREAM log entries). To start
speaking before the reply finishes, we pull *complete* sentences out of
the accumulating text and hand each to TTS immediately — the same
latency trick the frontend ``SentenceStreamExtractor`` uses, reimple-
mented server-side and Korean-aware.

Design goals:
  * Never re-emit a span already emitted (TTS must not repeat).
  * Prefer natural sentence boundaries (Korean + Latin terminators),
    but flush on a hard length ceiling so a run-on line still speaks.
  * Hold back a too-short trailing fragment until it grows or the turn
    ends (``flush``), avoiding choppy one-word clips.
"""

from __future__ import annotations

import re
from typing import List

# Sentence-ending punctuation: Latin + CJK fullwidth + ellipsis.
_TERMINATORS = ".!?…。！？"
# A boundary is a terminator (optionally followed by closing quotes/brackets)
# then whitespace or end-of-text. Korean has no inter-word spaces inside a
# sentence, so terminator-anchored splitting is the reliable signal.
_BOUNDARY_RE = re.compile(
    r"[" + re.escape(_TERMINATORS) + r"]+[\"'”’)\]】』」]*(?=\s|$)"
)
_NEWLINE_RE = re.compile(r"\n+")


class IncrementalSentenceExtractor:
    """Feed it the *cumulative* reply text; get back newly-completed
    sentences. Stateful across a single turn.

    Parameters
    ----------
    min_chars:
        A completed sentence shorter than this is held and merged with
        the next one, unless it is the final flush. Keeps TTS from
        firing on "네." fragments mid-stream. (Frontend uses 20.)
    max_chars:
        If unflushed pending text exceeds this with no terminator in
        sight, emit it anyway at the last whitespace so a long run-on
        line still starts speaking.
    """

    def __init__(self, min_chars: int = 12, max_chars: int = 180) -> None:
        self._min_chars = min_chars
        self._max_chars = max_chars
        self._emitted_len = 0          # chars of cumulative text already consumed
        self._cumulative = ""

    def push(self, cumulative_text: str) -> List[str]:
        """Update with the latest cumulative text, return sentences newly
        completed since the last call. May return zero or several."""
        if len(cumulative_text) < self._emitted_len:
            # Stream shrank (shouldn't happen) — resync defensively.
            self._emitted_len = 0
        self._cumulative = cumulative_text
        pending = cumulative_text[self._emitted_len:]
        if not pending:
            return []

        out: List[str] = []
        held = ""  # a short sentence waiting to merge with the next
        while pending:
            cut = self._next_cut(pending)
            if cut is None:
                break
            candidate = (held + pending[:cut]).strip()
            consumed = cut
            if candidate and len(candidate) < self._min_chars:
                # Too short → hold and merge forward. If more text follows in
                # this push it merges on the next iteration; if not, the
                # end-of-loop rollback keeps it pending for the next push/flush.
                held = held + pending[:cut]
                self._emitted_len += consumed
                pending = pending[cut:]
                continue
            if candidate:
                out.append(candidate)
            held = ""
            self._emitted_len += consumed
            pending = pending[cut:]

        # If we were holding a short fragment but hit no further boundary,
        # roll the cursor back so it stays pending for the next push/flush.
        if held:
            self._emitted_len -= len(held)
        return out

    def flush(self) -> List[str]:
        """Emit whatever remains as a final sentence (turn ended)."""
        remainder = self._cumulative[self._emitted_len:].strip()
        self._emitted_len = len(self._cumulative)
        return [remainder] if remainder else []

    def _next_cut(self, pending: str) -> int | None:
        """Index (exclusive) at which to cut the first complete sentence
        out of *pending*, or None if no complete sentence yet."""
        # Newline is a hard boundary.
        nl = _NEWLINE_RE.search(pending)
        m = _BOUNDARY_RE.search(pending)
        cuts = [c for c in (nl.end() if nl else None, m.end() if m else None) if c is not None]
        if cuts:
            return min(cuts)
        # No terminator — force a cut only past the length ceiling.
        if len(pending) >= self._max_chars:
            sp = pending.rfind(" ", 0, self._max_chars)
            return sp + 1 if sp > 0 else self._max_chars
        return None
