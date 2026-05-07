"""
ViewLedger — per-(agent, note) view tracking.

The agent must know which notes it has already encountered, and how many
times, in which contexts. Without this, the VTuber repeatedly treats
returning material as if it were brand new and the "continuous companion"
illusion breaks.

Design (mirrors docs §6.4):
  - Append-only JSONL is the source of truth for durability and crash
    safety. The in-memory index is built by replaying the JSONL on first
    use of a (user, agent) ledger.
  - All mutations go through a single per-ledger lock so concurrent
    knowledge tool calls don't interleave a record write with a read.
  - The ledger never raises into the caller's hot path: every public
    operation is wrapped so a malformed line or an I/O hiccup degrades
    to "no view data" rather than failing the underlying tool call.

Storage layout::

    {STORAGE_ROOT}/_view_ledger/{username}/
        {agent_id}.jsonl    ← append-only event log, source of truth
        {agent_id}.idx.json ← (later) compact snapshot for fast warm-start
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Tuple

from .types import (
    VIEW_EVENT_TYPES,
    ViewEventType,
    ViewKey,
    ViewRecord,
    parse_view_event_type,
)

logger = getLogger(__name__)


_DEFAULT_AGENT_ID = "default"
_AGENT_ID_SAFE_RE = re.compile(r"[^a-zA-Z0-9_.\-]")


def _safe_agent_id(agent_id: Optional[str]) -> str:
    """Sanitise agent_id so it is safe to use as a filename component.

    None / empty → "default". Forbidden characters (path separators,
    spaces, etc.) are replaced with underscores. Length capped at 64.
    """
    raw = (agent_id or _DEFAULT_AGENT_ID).strip() or _DEFAULT_AGENT_ID
    cleaned = _AGENT_ID_SAFE_RE.sub("_", raw)
    return cleaned[:64]


def _safe_note_id(note_id: str) -> str:
    """Note IDs are echoed back as-is in the JSONL but trimmed."""
    return (note_id or "").strip()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _parse_iso(value: Any, *, default: Optional[datetime] = None) -> datetime:
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except ValueError:
            pass
    return default or _utc_now()


# ── Ledger snapshot for read-only consumers ───────────────────────────


class ViewLedgerSnapshot:
    """Read-only view onto a ledger's records — handed to Organizer (P5)."""

    __slots__ = ("_records",)

    def __init__(self, records: Mapping[ViewKey, ViewRecord]):
        # Defensive copy so callers can't mutate the live dict.
        self._records = dict(records)

    def get(self, key: ViewKey) -> Optional[ViewRecord]:
        return self._records.get(key)

    def __contains__(self, key: ViewKey) -> bool:
        return key in self._records

    def items(self) -> Iterable[Tuple[ViewKey, ViewRecord]]:
        return self._records.items()

    def __len__(self) -> int:
        return len(self._records)


# ── Ledger ────────────────────────────────────────────────────────────


class ViewLedger:
    """Per-(user, agent) view ledger.

    One ledger instance corresponds to one ``{username}/{agent_id}.jsonl``
    file. The :func:`get_view_ledger` factory caches instances per (user,
    agent) so concurrent tool calls share both the in-memory index and
    the per-ledger lock.
    """

    def __init__(self, *, base_path: str, username: str, agent_id: str):
        self.username = username
        self.agent_id = _safe_agent_id(agent_id)
        self._dir = Path(base_path) / "_view_ledger" / username
        self._jsonl = self._dir / f"{self.agent_id}.jsonl"
        self._lock = threading.RLock()
        self._records: MutableMapping[ViewKey, ViewRecord] = {}
        self._loaded = False

    # ── Setup ─────────────────────────────────────────────────────

    def _ensure_dir(self) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            logger.debug("ViewLedger: mkdir failed for %s", self._dir, exc_info=True)

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._records = {}
            if self._jsonl.exists():
                try:
                    for line in self._jsonl.read_text(encoding="utf-8").splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            self._apply_line(json.loads(line))
                        except Exception:  # noqa: BLE001
                            logger.debug(
                                "ViewLedger: skipping malformed line in %s",
                                self._jsonl,
                                exc_info=True,
                            )
                except OSError:
                    logger.debug(
                        "ViewLedger: failed to read %s",
                        self._jsonl,
                        exc_info=True,
                    )
            self._loaded = True

    def _apply_line(self, payload: Dict[str, Any]) -> None:
        """Replay a single JSONL line into the in-memory index."""
        try:
            event_type = parse_view_event_type(str(payload.get("event_type")))
        except ValueError:
            return
        note_id = _safe_note_id(str(payload.get("note_id") or ""))
        if not note_id:
            return
        key = ViewKey(agent_id=self.agent_id, note_id=note_id)
        ts = _parse_iso(payload.get("ts"))
        context = payload.get("context")
        record = self._records.get(key)
        if record is None:
            record = ViewRecord.empty(key, now=ts)
            self._records[key] = record
            record.first_seen_at = ts
        record.last_seen_at = ts
        record.counts[event_type] = record.counts.get(event_type, 0) + 1
        record.last_event = event_type
        record.last_context = context if isinstance(context, str) else record.last_context

    # ── Public API ────────────────────────────────────────────────

    def record(
        self,
        note_id: str,
        event_type: str,
        *,
        context: Optional[str] = None,
        ts: Optional[datetime] = None,
    ) -> Optional[ViewRecord]:
        """Record a single view event.

        Best-effort: any failure is logged at debug level and returns
        ``None`` rather than raising into the tool's hot path.
        """
        clean_note = _safe_note_id(note_id)
        if not clean_note:
            return None
        try:
            event = parse_view_event_type(event_type)
        except ValueError:
            logger.debug("ViewLedger.record: ignoring unknown event %r", event_type)
            return None

        when = ts or _utc_now()
        line: Dict[str, Any] = {
            "ts": _isoformat(when),
            "agent_id": self.agent_id,
            "note_id": clean_note,
            "event_type": event,
        }
        if context:
            line["context"] = context

        with self._lock:
            self._ensure_loaded()
            key = ViewKey(agent_id=self.agent_id, note_id=clean_note)
            record = self._records.get(key)
            if record is None:
                record = ViewRecord.empty(key, now=when)
                self._records[key] = record
            record.last_seen_at = when
            record.counts[event] = record.counts.get(event, 0) + 1
            record.last_event = event
            if context:
                record.last_context = context

            self._ensure_dir()
            try:
                with self._jsonl.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(line, ensure_ascii=False) + "\n")
            except OSError:
                logger.debug(
                    "ViewLedger.record: append failed for %s",
                    self._jsonl,
                    exc_info=True,
                )
            return record

    def record_many(
        self,
        note_ids: Iterable[str],
        event_type: str,
        *,
        context: Optional[str] = None,
    ) -> int:
        """Record the same event for each ``note_id`` in one batch."""
        count = 0
        for note_id in note_ids:
            if self.record(note_id, event_type, context=context) is not None:
                count += 1
        return count

    def get(self, note_id: str) -> Optional[ViewRecord]:
        clean = _safe_note_id(note_id)
        if not clean:
            return None
        self._ensure_loaded()
        return self._records.get(ViewKey(agent_id=self.agent_id, note_id=clean))

    def view_meta(self, note_id: str) -> Dict[str, Any]:
        record = self.get(note_id)
        if record is None:
            return {
                "seen": False,
                "counts": {},
                "first_seen_at": None,
                "last_seen_at": None,
                "last_event": None,
            }
        return record.view_meta()

    def decorate(
        self,
        items: List[Dict[str, Any]],
        *,
        field: str = "filename",
        meta_key: str = "_view",
    ) -> List[Dict[str, Any]]:
        """Attach a `_view` block to each item dict in place.

        ``field`` is the dict key holding the note identifier (default
        ``filename`` to match the user-opsidian / curated knowledge
        result shape). Items without that key get an empty meta block.
        """
        if not items:
            return items
        self._ensure_loaded()
        for item in items:
            if not isinstance(item, dict):
                continue
            note_id = item.get(field)
            if not note_id:
                item[meta_key] = {
                    "seen": False,
                    "counts": {},
                    "first_seen_at": None,
                    "last_seen_at": None,
                    "last_event": None,
                }
                continue
            item[meta_key] = self.view_meta(str(note_id))
        return items

    def snapshot(self) -> ViewLedgerSnapshot:
        self._ensure_loaded()
        with self._lock:
            return ViewLedgerSnapshot(self._records)

    def stats(self) -> Dict[str, Any]:
        """Aggregate counts — useful for /api/whiteboard/views/stats."""
        self._ensure_loaded()
        per_event: Dict[str, int] = {ev: 0 for ev in VIEW_EVENT_TYPES}
        seen_notes = 0
        for record in self._records.values():
            if record.has_seen():
                seen_notes += 1
            for event_type, count in record.counts.items():
                per_event[event_type] = per_event.get(event_type, 0) + int(count)
        return {
            "agent_id": self.agent_id,
            "username": self.username,
            "total_notes_seen": seen_notes,
            "events": per_event,
        }

    # ── Maintenance ───────────────────────────────────────────────

    def reset_for_tests(self) -> None:
        """Test-only: drop the in-memory index and any on-disk JSONL."""
        with self._lock:
            self._records = {}
            self._loaded = False
            try:
                if self._jsonl.exists():
                    self._jsonl.unlink()
            except OSError:
                pass


# ── Module-level cache ────────────────────────────────────────────────

_ledger_cache: Dict[Tuple[str, str], ViewLedger] = {}
_cache_lock = threading.Lock()


def _default_storage_root() -> str:
    try:
        from service.utils.platform import DEFAULT_STORAGE_ROOT  # type: ignore
        return DEFAULT_STORAGE_ROOT
    except Exception:  # noqa: BLE001
        return os.environ.get("GENY_STORAGE_ROOT", os.path.join(os.getcwd(), "storage"))


def get_view_ledger(
    username: str,
    agent_id: Optional[str] = None,
    *,
    base_path: Optional[str] = None,
) -> ViewLedger:
    """Return the cached :class:`ViewLedger` for (user, agent_id).

    Thread-safe: the per-(user, agent) instance is created at most once.
    Tests can pass ``base_path`` to avoid touching the real storage root.
    """
    safe_agent = _safe_agent_id(agent_id)
    cache_key = (username, safe_agent)
    if base_path is None:
        base = _default_storage_root()
    else:
        base = base_path
    with _cache_lock:
        existing = _ledger_cache.get(cache_key)
        if existing is not None and existing._dir.parent.parent == Path(base):  # noqa: SLF001
            return existing
        ledger = ViewLedger(
            base_path=base,
            username=username,
            agent_id=safe_agent,
        )
        # Only cache when using the default root — tests that pass a
        # custom base_path should always get a fresh instance.
        if base_path is None:
            _ledger_cache[cache_key] = ledger
        return ledger
