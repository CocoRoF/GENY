"""Multi-language sentence splitter for streaming TTS (Phase 4).

OmniVoice's :py:meth:`omnivoice_core.models.OmniVoice.generate` is
non-streaming: a single call produces one PCM array for the whole input
text. To deliver an interactive feel for chat-style payloads (where the
LLM may emit several sentences in one response) we split the text into
sentences on the *client* side of the model and feed them through one
generation call each. The resulting PCM chunks are then framed onto
the wire in order, so the listener hears sentence #1 while the model is
still synthesising sentence #2.

Splitting rules
---------------

We segment on *terminal* punctuation common to the languages OmniVoice
ships with (English, Korean, Japanese, Chinese), keeping the punctuation
attached to the preceding clause:

* ``. ! ?`` (Latin)
* ``。 ！ ？`` (CJK fullwidth)
* ``…``      (ellipsis is treated as a soft terminator)

Newlines in the source text always end a sentence — chat models
frequently emit ``"Hello.\\n\\nHow are you?"`` and we don't want a long
silent gap from a synthesiser inferring continuity.

Length safety
-------------

Sentences longer than ``max_chars`` are *soft-split* on whitespace at a
character budget, then on hard character cut as a last resort, so a
runaway non-stopping sentence still gets fed to the model in
manageable chunks (default 240 chars ≈ 12s of audio).

Empty / whitespace-only fragments are silently dropped.
"""

from __future__ import annotations

import logging
import re
from typing import Iterable, List

logger = logging.getLogger("server.text_split")


# Terminal punctuation: a character class of all sentence enders. The
# regex captures the terminator so we keep it attached to the segment.
_TERMINATOR = r"[.!?。！？…]"
_SENTENCE_RE = re.compile(rf"([^\n]+?{_TERMINATOR}+|[^\n]+)\s*", re.DOTALL)


def split_sentences(text: str, *, max_chars: int = 240) -> List[str]:
    """Split ``text`` into a list of sentences, each ≤ ``max_chars``.

    The split is greedy left-to-right; the punctuation stays with the
    preceding clause. ``max_chars`` only affects the *soft-split* of
    abnormally long fragments — sentences shorter than the budget are
    returned untouched.
    """
    if not text or not text.strip():
        return []
    if max_chars <= 0:
        raise ValueError("max_chars must be > 0")

    out: List[str] = []
    # Split on hard newlines first; chat / markdown payloads use them as
    # implicit sentence breaks.
    for paragraph in text.split("\n"):
        para = paragraph.strip()
        if not para:
            continue
        # Apply the regex to find runs ending in a terminator. Anything
        # left without a terminator becomes its own segment so we don't
        # drop the tail of an unfinished sentence.
        for match in _SENTENCE_RE.finditer(para):
            segment = match.group(1).strip()
            if not segment:
                continue
            if len(segment) <= max_chars:
                out.append(segment)
            else:
                out.extend(_soft_split(segment, max_chars=max_chars))
    return out


def _soft_split(segment: str, *, max_chars: int) -> List[str]:
    """Split a too-long segment on whitespace, falling back to hard cut.

    Tries to break at a space near the budget boundary; if the segment
    has no whitespace at all (e.g. a long URL or a CJK run with no
    spaces) it falls back to a fixed-width slice.
    """
    pieces: List[str] = []
    remaining = segment
    while len(remaining) > max_chars:
        # Look for the last whitespace within the budget; if none, hard cut.
        cut = remaining.rfind(" ", 0, max_chars)
        if cut <= 0:
            cut = max_chars
        head = remaining[:cut].strip()
        if head:
            pieces.append(head)
        remaining = remaining[cut:].lstrip()
    if remaining.strip():
        pieces.append(remaining.strip())
    return pieces


def chunked_sentences(text: str, *, max_chars: int = 240) -> Iterable[tuple[int, str]]:
    """Yield ``(seq, sentence)`` pairs, ``seq`` starting at 0.

    Convenience wrapper for the streaming endpoint, which needs the
    sequence number to label each PCM chunk on the wire.
    """
    for i, s in enumerate(split_sentences(text, max_chars=max_chars)):
        yield i, s
