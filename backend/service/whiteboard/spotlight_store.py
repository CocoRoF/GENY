"""
SpotlightStore — ephemeral "look at this right now" items per session.

Spotlight is the second of the two sharing modes (the first being
Library / curated promotion).  Items are kept in memory, optionally
mirrored to disk, expire on a TTL, and are read by the (P2b)
SpotlightContextSection on every prompt build.

Concurrency: one ``threading.RLock`` per store instance.  All public
operations are O(items) and items are bounded by ``MAX_PER_SESSION``,
so the lock contention is negligible compared with model calls.

This module is deliberately stateless across processes — VTuber
shares a single Python process with the rest of the backend; if we
later split processes, swap the in-memory dict for a Redis-backed
one without changing the public API.
"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timedelta, timezone
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .types import SpotlightItem

logger = getLogger(__name__)


DEFAULT_TTL_MINUTES = 30
MAX_PER_SESSION = 16


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class SpotlightStore:
    """Per-process spotlight registry, keyed by ``(user_id, session_id)``."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # session_id of None = user-wide spotlight (rare).
        self._items: Dict[Tuple[str, Optional[str]], List[SpotlightItem]] = {}

    # ── core ops ───────────────────────────────────────────────────

    def add(
        self,
        *,
        user_id: str,
        session_id: Optional[str],
        source_filename: str,
        title: str,
        excerpt: str,
        attachments: Iterable[str] = (),
        ttl_minutes: int = DEFAULT_TTL_MINUTES,
        pinned: bool = False,
        capture_id: Optional[str] = None,
        note_kind: str = "user",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SpotlightItem:
        """Stage a new spotlight item; returns the canonical record."""
        item = SpotlightItem(
            item_id=uuid.uuid4().hex,
            user_id=user_id,
            session_id=session_id,
            source_filename=source_filename,
            title=title or source_filename,
            excerpt=(excerpt or "")[:1000],
            attachments=tuple(str(a) for a in attachments),
            capture_id=capture_id,
            note_kind=note_kind,  # type: ignore[arg-type]
            expires_at=_utc_now() + timedelta(minutes=max(1, int(ttl_minutes))),
            pinned=bool(pinned),
            metadata=dict(metadata or {}),
        )
        key = (user_id, session_id)
        with self._lock:
            bucket = self._items.setdefault(key, [])
            bucket.append(item)
            # Drop the oldest non-pinned item if we are over the cap.
            if len(bucket) > MAX_PER_SESSION:
                for i, existing in enumerate(bucket):
                    if not existing.pinned:
                        bucket.pop(i)
                        break
        return item

    def list(
        self,
        *,
        user_id: str,
        session_id: Optional[str] = None,
        include_expired: bool = False,
    ) -> List[SpotlightItem]:
        """Return active spotlight items visible to ``(user_id, session_id)``.

        Merge semantics:
          * ``session_id`` is None → user-wide bucket only.
          * ``session_id`` is set → merge user-wide AND that session's
            bucket. This is the right shape for VTuber prompt builds:
            a note shared from the inbox UI (no active session in
            scope) ends up in the user-wide bucket, and every running
            session for that user picks it up automatically.

        Newer items are returned later — callers that want
        newest-first should reverse the result.
        """
        keys: List[Tuple[str, Optional[str]]] = [(user_id, None)]
        if session_id is not None and session_id != "":
            keys.append((user_id, session_id))
        with self._lock:
            bucket: List[SpotlightItem] = []
            for key in keys:
                bucket.extend(self._items.get(key, ()))
        # Stable de-dup on item_id in case the same item somehow lands
        # in both buckets (defence in depth — current writers don't).
        seen_ids: set[str] = set()
        deduped: List[SpotlightItem] = []
        for item in bucket:
            if item.item_id in seen_ids:
                continue
            seen_ids.add(item.item_id)
            deduped.append(item)
        deduped.sort(key=lambda i: i.created_at)
        if include_expired:
            return deduped
        now = _utc_now()
        return [item for item in deduped if not item.is_expired(now)]

    def get(self, *, user_id: str, item_id: str) -> Optional[SpotlightItem]:
        with self._lock:
            for bucket in self._items.values():
                for item in bucket:
                    if item.user_id == user_id and item.item_id == item_id:
                        return item
        return None

    def remove(self, *, user_id: str, item_id: str) -> bool:
        with self._lock:
            for key, bucket in self._items.items():
                for i, item in enumerate(bucket):
                    if item.user_id == user_id and item.item_id == item_id:
                        bucket.pop(i)
                        if not bucket:
                            del self._items[key]
                        return True
        return False

    def clear_session(self, *, user_id: str, session_id: Optional[str]) -> int:
        with self._lock:
            bucket = self._items.pop((user_id, session_id), [])
        return len(bucket)

    def expire_due(self, *, now: Optional[datetime] = None) -> int:
        """Remove all expired non-pinned items. Returns the count removed."""
        ts = now or _utc_now()
        removed = 0
        with self._lock:
            empty_keys: List[Tuple[str, Optional[str]]] = []
            for key, bucket in self._items.items():
                kept = [item for item in bucket if not item.is_expired(ts)]
                removed += len(bucket) - len(kept)
                if kept:
                    self._items[key] = kept
                else:
                    empty_keys.append(key)
            for key in empty_keys:
                del self._items[key]
        return removed

    def reset_for_tests(self) -> None:
        with self._lock:
            self._items.clear()


# ── Module singleton ─────────────────────────────────────────────────

_store_singleton: Optional[SpotlightStore] = None
_singleton_lock = threading.Lock()


def get_spotlight_store() -> SpotlightStore:
    global _store_singleton
    if _store_singleton is None:
        with _singleton_lock:
            if _store_singleton is None:
                _store_singleton = SpotlightStore()
    return _store_singleton
