"""Daily journal index writer — Memory v2 PR 4.

Per-day chronological index at ``memory/<YYYY-MM-DD>.md`` (root
level — sits next to ``MEMORY.md``). Body is a chronologically
sorted list of one-line headlines, each pointing at its
conversations/ leaf (cf. plan §1.7).

Unlike ``dms/<cp>/<date>.md`` which is keyed by counterpart, the
daily journal is keyed only by date — every turn lands here, even
self-reflections. The two files are the *index* layer that
``record_message`` paints under the leaf SoT (conversations/) on
every call.

Implementation mirrors ``DmArchiver`` deliberately: same
append-shaped read-modify-write, same RLock, same idempotence
when a stale ``event_id`` re-appears (no double-counting).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, tzinfo
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from service.memory.conversation_archiver import short_event_id
from service.memory.frontmatter import parse_frontmatter, render_frontmatter
from service.memory.interaction_event import (
    Direction,
    InteractionEventView,
    parse_event_metadata,
)
from service.utils.utils import _configured_tz as _get_tz

logger = logging.getLogger(__name__)


CATEGORY = "daily-journal"  # frontmatter category — distinct from
                            # the existing ``daily/`` free-form
                            # subfolder so search filters can
                            # disambiguate.

#: Counterparts that *do* belong in the daily journal (plan §1.7).
#: Empty set ⇒ all counterparts qualify; the only thing the daily
#: journal filters on is "did record_message produce a parsed
#: InteractionEvent". We keep the set explicit for symmetry with
#: ``dm_archiver`` and easy extension.
ALL_KINDS = None  # sentinel — accept any


@dataclass(frozen=True)
class DailyJournalUpdate:
    relative_path: str   # e.g. "2026-05-01.md"
    absolute_path: str
    event_count: int


class DailyJournalWriter:
    """Writer for ``memory/<YYYY-MM-DD>.md``."""

    CATEGORY = CATEGORY

    def __init__(
        self,
        memory_dir: str,
        *,
        session_id: str = "",
        tz: Optional[tzinfo] = None,
        index_manager: Optional[Any] = None,
    ) -> None:
        self._memory_dir = Path(memory_dir)
        self._session_id = session_id
        self._tz = tz or _get_tz()
        import threading
        self._lock = threading.RLock()
        self._index_manager = index_manager

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    def append(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]],
        conversation_ref: Optional[str] = None,
    ) -> Optional[DailyJournalUpdate]:
        """Append one turn entry to today's journal."""
        view = parse_event_metadata(metadata)
        if view is None:
            return None
        try:
            return self._append_locked(role, content, view, conversation_ref)
        except Exception:
            logger.debug(
                "daily_journal_writer: append failed — non-critical",
                exc_info=True,
            )
            return None

    # ── internal ─────────────────────────────────────────────────

    def _append_locked(
        self,
        role: str,
        content: str,
        view: InteractionEventView,
        conversation_ref: Optional[str],
    ) -> Optional[DailyJournalUpdate]:
        ts = self._resolve_ts(view.metadata)
        date = ts.date().isoformat()
        rel_path = f"{date}.md"
        abs_path = self._memory_dir / rel_path
        with self._lock:
            existing_meta, existing_body = self._load_or_init(abs_path, date)
            entry = self._render_entry(view, ts, role, content, conversation_ref)
            new_body = (existing_body.rstrip() + "\n\n" + entry).strip() + "\n"
            new_meta = self._update_meta(existing_meta, view, ts)
            full_text = render_frontmatter(new_meta, new_body)
            try:
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                abs_path.write_text(full_text, encoding="utf-8")
            except OSError as exc:
                logger.warning(
                    "daily_journal_writer: write failed for %s: %s",
                    abs_path, exc,
                )
                return None
            if self._index_manager is not None:
                try:
                    self._index_manager.update_file(rel_path)
                except Exception:
                    logger.debug(
                        "daily_journal_writer: index update failed",
                        exc_info=True,
                    )
            return DailyJournalUpdate(
                relative_path=rel_path,
                absolute_path=str(abs_path),
                event_count=int(new_meta.get("event_count", 0)),
            )

    def _resolve_ts(self, metadata: Dict[str, Any]) -> datetime:
        raw = metadata.get("ts")
        if isinstance(raw, str) and raw:
            try:
                parsed = datetime.fromisoformat(raw)
                return (
                    parsed.astimezone(self._tz)
                    if parsed.tzinfo
                    else parsed.replace(tzinfo=self._tz)
                )
            except ValueError:
                pass
        return datetime.now(self._tz)

    def _load_or_init(self, abs_path: Path, date: str) -> Tuple[Dict[str, Any], str]:
        if abs_path.exists():
            try:
                text = abs_path.read_text(encoding="utf-8")
                meta, body = parse_frontmatter(text)
                if meta:
                    eids = meta.get("event_ids")
                    if isinstance(eids, str):
                        meta["event_ids"] = [
                            e.strip() for e in eids.split(",") if e.strip()
                        ]
                    elif not isinstance(eids, list):
                        meta["event_ids"] = []
                    return meta, body
            except OSError as exc:
                logger.debug(
                    "daily_journal_writer: read failed for %s: %s",
                    abs_path, exc,
                )
        meta = {
            "title": f"Day journal — {date}",
            "category": CATEGORY,
            "date": date,
            "tags": ["daily-journal"],
            "importance": "medium",
            "event_count": 0,
            "event_ids": [],
            "session_id": self._session_id,
            "links_to": [],
            "linked_from": [],
        }
        body = f"# {date}\n"
        return meta, body

    def _update_meta(
        self,
        meta: Dict[str, Any],
        view: InteractionEventView,
        ts: datetime,
    ) -> Dict[str, Any]:
        new_meta = dict(meta)
        eids = list(new_meta.get("event_ids") or [])
        if view.event_id and view.event_id not in eids:
            eids.append(view.event_id)
        new_meta["event_ids"] = eids
        new_meta["event_count"] = len(eids)
        new_meta["modified"] = ts.isoformat()
        return new_meta

    @staticmethod
    def _render_entry(
        view: InteractionEventView,
        ts: datetime,
        role: str,
        content: str,
        conversation_ref: Optional[str],
    ) -> str:
        arrow = (
            "→" if view.direction == Direction.OUT.value
            else "←" if view.direction == Direction.IN.value
            else "·"
        )
        time_str = ts.strftime("%H:%M:%S")
        cp_short = (view.counterpart_id or "")[:8] if view.counterpart_id else ""
        cp_part = f" {arrow} {cp_short}" if cp_short else ""
        excerpt = ""
        for line in (content or "").splitlines():
            line = line.strip()
            if line:
                excerpt = line[:140]
                if len(line) > 140:
                    excerpt = excerpt.rstrip() + "…"
                break
        lines = [f"## {time_str} · {view.kind}{cp_part}"]
        if excerpt:
            lines.append(f"> {excerpt}")
        if conversation_ref:
            ref_target = conversation_ref[:-3] if conversation_ref.endswith(".md") else conversation_ref
            lines.append(f"[[{ref_target}|→ 본문]]")
        eid_short = short_event_id(view.event_id, width=8)
        lines.append(f"_event_id: `{eid_short}`_")
        return "\n".join(lines)


__all__ = [
    "CATEGORY",
    "DailyJournalUpdate",
    "DailyJournalWriter",
]
