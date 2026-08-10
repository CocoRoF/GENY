"""Retention for the notes the agent writes to ITSELF.

The screen-observation trigger writes a note every couple of minutes,
forever: 757 in one production day, 6,180 total, plus 2,486 per-execution
`daily` records. 99.5% of that vault is machine-authored. Nothing ever
removed any of it, so every improvement to indexing is a delay, not a fix —
the cost curve just keeps climbing.

The media sweep next door already drops the FRAMES after a week
(`media_retention`), which is why an old observation is a caption with no
picture. This is the other half: the notes themselves.

What it will never delete, because getting this wrong is unrecoverable:

  * anything the user marked ``critical`` — that is the author's own
    never-forget declaration, and age says nothing about it;
  * ``__``-prefixed files — digests and ledgers, which are the *summary* of
    what is being pruned and must outlive it;
  * anything outside the configured categories. Human-written notes and
    conversations are not on a timer.

Set ``GENY_NOTE_RETENTION_DAYS=0`` to disable entirely.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, List, Sequence

logger = logging.getLogger(__name__)

#: Categories written by autonomous loops rather than by a person. Only these
#: are ever aged out. Deliberately NOT `conversations`, `critical`, `memory`
#: or `note` — those are the record of what actually happened between the
#: user and the agent.
AUTONOMOUS_CATEGORIES = ("observations", "daily")

#: An observation loses its frame after a week and its value long before a
#: month. Generous by default because deletion is one-way.
DEFAULT_RETENTION_DAYS = 30

#: How many to remove in one sweep. A vault that has never been pruned
#: presents thousands at once, and a delete is a write — taking the engine
#: for an unbounded stretch is the failure mode this whole effort exists to
#: prevent.
DEFAULT_MAX_PER_SWEEP = 500


def retention_days() -> int:
    try:
        return int(os.environ.get("GENY_NOTE_RETENTION_DAYS", "") or
                   DEFAULT_RETENTION_DAYS)
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def max_per_sweep() -> int:
    try:
        return int(os.environ.get("GENY_NOTE_RETENTION_MAX_PER_SWEEP", "") or
                   DEFAULT_MAX_PER_SWEEP)
    except ValueError:
        return DEFAULT_MAX_PER_SWEEP


@dataclass(frozen=True)
class Expired:
    filename: str
    category: str


def _importance_of(meta: Any) -> str:
    imp = getattr(meta, "importance", None)
    if imp is None:
        return ""
    return str(getattr(imp, "value", imp)).lower()


def _age_of(meta: Any, now: datetime) -> timedelta:
    stamp = getattr(meta, "updated_at", None) or getattr(meta, "created_at", None)
    if stamp is None:
        return timedelta(0)
    try:
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return now - stamp
    except (AttributeError, TypeError):
        return timedelta(0)


def select_expired(
    metas: Iterable[Any],
    *,
    now: datetime,
    days: int,
    categories: Sequence[str] = AUTONOMOUS_CATEGORIES,
    limit: int = DEFAULT_MAX_PER_SWEEP,
) -> List[Expired]:
    """Which notes have aged out. Pure — decides nothing about deleting.

    ``days <= 0`` selects nothing, so the feature is off by configuration
    rather than by a caller remembering to check.
    """
    if days <= 0:
        return []
    cutoff = timedelta(days=days)
    allowed = {c.lower() for c in categories}
    scored: List[tuple] = []
    for meta in metas:
        ref = getattr(meta, "ref", None)
        if ref is None:
            continue
        category = str(getattr(ref, "category", "") or "").lower()
        if category not in allowed:
            continue
        filename = str(getattr(ref, "filename", "") or "")
        if not filename or filename.startswith("__"):
            continue
        if _importance_of(meta) == "critical":
            continue
        age = _age_of(meta, now)
        if age <= cutoff:
            continue
        scored.append((age, Expired(filename=filename, category=category)))
    # Oldest first BY AGE, not by name: observation filenames happen to sort
    # chronologically but `daily/execution-14-…` does not, and a capped sweep
    # must chew through the real backlog rather than whatever the listing
    # happened to yield first.
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [e for _age, e in scored[:max(0, limit)]]
