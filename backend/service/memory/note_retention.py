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

#: …and a CEILING on how many of each autonomous category to keep, because
#: an age window alone does not bound anything: at the measured 757
#: observations/day, 30 days settles at ~22,700 notes — four times the vault
#: this was meant to stop growing. The write rate is not a constant anyone
#: controls, so the guarantee has to be a count. Oldest go first.
DEFAULT_MAX_PER_CATEGORY = 4000

#: How many to remove in one sweep. A vault that has never been pruned
#: presents thousands at once, and a delete is a write — taking the engine
#: for an unbounded stretch is the failure mode this whole effort exists to
#: prevent.
DEFAULT_MAX_PER_SWEEP = 200

#: …and a wall-clock ceiling on top, because the count is a poor proxy: a
#: delete touches the notes store, the sidecar index and the vector index,
#: and how long that takes depends on the disk. The first version of this
#: sweep ran inside the session warm-up with no clock at all and starved a
#: live turn for 300 seconds. Whatever is left waits for the next sweep.
DEFAULT_MAX_SECONDS = 30.0


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


def max_per_category() -> int:
    try:
        return int(os.environ.get("GENY_NOTE_RETENTION_MAX_PER_CATEGORY", "") or
                   DEFAULT_MAX_PER_CATEGORY)
    except ValueError:
        return DEFAULT_MAX_PER_CATEGORY


def max_seconds() -> float:
    try:
        return float(os.environ.get("GENY_NOTE_RETENTION_MAX_SECONDS", "") or
                     DEFAULT_MAX_SECONDS)
    except ValueError:
        return DEFAULT_MAX_SECONDS


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
    keep_per_category: int = 0,
) -> List[Expired]:
    """Which notes should go. Pure — decides nothing about deleting.

    Two independent reasons, because either alone leaves a hole:

    * AGE — older than *days*. Bounds staleness, but not size: the write
      rate is nobody's constant, and at 757/day a 30-day window settles at
      ~22,700 notes.
    * COUNT — beyond the newest *keep_per_category* in its category. Bounds
      size no matter the rate. Oldest first.

    ``days <= 0`` disables the age rule; ``keep_per_category <= 0`` disables
    the count rule. Both off selects nothing, so the feature is off by
    configuration rather than by a caller remembering to check.
    """
    if days <= 0 and keep_per_category <= 0:
        return []
    cutoff = timedelta(days=days) if days > 0 else None
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
        scored.append((age, category, Expired(filename=filename, category=category)))

    # Oldest first BY AGE, not by name: observation filenames happen to sort
    # chronologically but `daily/execution-14-…` does not, and a capped sweep
    # must chew through the real backlog rather than whatever the listing
    # happened to yield first.
    scored.sort(key=lambda row: row[0], reverse=True)

    doomed: List[Expired] = []
    seen_per_category: dict = {}
    total_per_category: dict = {}
    for age, category, _e in scored:
        total_per_category[category] = total_per_category.get(category, 0) + 1
    for age, category, expired in scored:
        rank = seen_per_category.get(category, 0)
        seen_per_category[category] = rank + 1
        too_old = cutoff is not None and age > cutoff
        # `rank` counts from the OLDEST, so everything before the last
        # `keep_per_category` entries of this category is surplus.
        surplus = (
            keep_per_category > 0
            and rank < total_per_category[category] - keep_per_category
        )
        if too_old or surplus:
            doomed.append(expired)
    return doomed[:max(0, limit)]
