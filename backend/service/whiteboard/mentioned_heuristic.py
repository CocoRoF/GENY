"""
``mentioned`` heuristic — record a ``ViewLedger`` event when the
agent's response text references a known whiteboard note.

Why heuristic: matching agent prose to a note's title is fuzzy by
nature. A spurious match (false positive) only inflates the
``mentioned`` counter — it doesn't break correctness — so the
heuristic is allowed to be lenient.

Why opt-in: producing the inflated counter for every assistant
response costs a regex pass per spotlight item per turn. Default-off
keeps the cost of the whiteboard surface zero for sessions that
don't share any note, and the user / operator can flip it on with
``GENY_WHITEBOARD_TRACK_MENTIONED=1``.
"""

from __future__ import annotations

import os
import re
from logging import getLogger
from typing import Iterable, Optional

# Imported at module top so monkeypatching `mentioned_heuristic.<name>`
# in tests actually intercepts the call. Cycle-safe: each of these
# touches only the small ``service.whiteboard`` typed modules.
from .agent_resolver import resolve_user_and_agent
from .spotlight_store import get_spotlight_store
from .view_ledger import get_view_ledger

logger = getLogger(__name__)


def _is_enabled() -> bool:
    return os.environ.get("GENY_WHITEBOARD_TRACK_MENTIONED", "").lower() in (
        "1",
        "true",
        "yes",
    )


def _strip_extension(filename: str) -> str:
    if filename.endswith(".md"):
        return filename[:-3]
    return filename


def _candidate_phrases(title: str, filename: str) -> list[str]:
    """Return lowercase phrases worth grepping for in the response.

    Filters out very short phrases (≤ 3 chars) that would otherwise
    match every other word in normal prose.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in (title, _strip_extension(filename), filename):
        s = (raw or "").strip().lower()
        if not s or len(s) <= 3:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def detect_mentions(
    response_text: str, *, candidates: Iterable[tuple[str, str]]
) -> list[str]:
    """Return the ``filename`` for every candidate whose title or
    filename appears in ``response_text``.

    ``candidates`` is an iterable of ``(filename, title)`` tuples.
    Match is lowercase substring match — fuzzy-enough without being
    spammy.
    """
    if not response_text:
        return []
    haystack = response_text.lower()
    hits: list[str] = []
    for filename, title in candidates:
        for phrase in _candidate_phrases(title, filename):
            if phrase in haystack:
                hits.append(filename)
                break
    return hits


def maybe_record_mentions(
    *,
    session_id: str,
    response_text: str,
) -> int:
    """Inspect ``response_text`` for active spotlight item mentions
    and record one ``mentioned`` event per match.

    Returns the number of mentions recorded. No-op when the
    heuristic is disabled or no candidate notes are active.
    """
    if not _is_enabled():
        return 0
    if not response_text or len(response_text) < 8:
        return 0

    username, agent_id = resolve_user_and_agent(session_id)
    if not username or not agent_id:
        return 0
    store = get_spotlight_store()
    items = store.list(user_id=username, session_id=session_id)
    if not items:
        return 0

    candidates = [(item.source_filename, item.title or "") for item in items]
    hits = detect_mentions(response_text, candidates=candidates)
    if not hits:
        return 0

    ledger = get_view_ledger(username, agent_id)
    recorded = 0
    for filename in hits:
        try:
            ledger.record(filename, "mentioned", context=f"session:{session_id}")
            recorded += 1
        except Exception:  # noqa: BLE001
            logger.debug("mentioned record failed", exc_info=True)
    return recorded
