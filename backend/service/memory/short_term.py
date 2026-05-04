"""
Short-term memory — thin adapter over `provider.stm()`.

Geny path-A migration GENY-1: the JSONL transcript file is owned by
the executor's `STMHandle` (`<storage>/transcripts/session.jsonl`),
not Geny. This module preserves the legacy `ShortTermMemory` surface
that the rest of Geny uses (manager, transcripts controller, memory
inspect tools, agent executor) and routes every write through the
provider so there's a single STM trail per session.

Layout (executor-owned)::

    <storage_path>/
        transcripts/
            session.jsonl       ← executor.STMHandle (append/recent/search)
            summary.md          ← Geny side (executor STM has no summary surface)

Geny still drives:
- DB dual-write (`session_memory_entries` mirror) for operator analytics
- `summary.md` direct disk write (no executor protocol equivalent)
- `MemoryEntry` / `MemorySearchResult` shape adapters for legacy callers
"""

from __future__ import annotations

from datetime import datetime
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from service.memory.types import MemoryEntry, MemorySearchResult, MemorySource

logger = getLogger(__name__)

# Use configured timezone from GENY_TIMEZONE env var
from service.utils.utils import _configured_tz as _get_tz


_RECENT_LARGE_N = 5000


class ShortTermMemory:
    """Thin adapter over the executor's STMHandle.

    Construction stays compatible with the pre-migration call site
    (`ShortTermMemory(storage_path)`); attach the executor provider
    via `set_memory_provider(provider)` once the agent session has
    built it. All writes (`add_message`, `add_event`, `write_summary`)
    are no-ops + warning if no provider is attached, mirroring the
    PR-3g pattern for `StructuredMemoryWriter`.
    """

    TRANSCRIPT_DIR = "transcripts"
    MAIN_FILE = "session.jsonl"
    SUMMARY_FILE = "summary.md"

    def __init__(self, storage_path: str):
        self._storage_path = Path(storage_path)
        self._transcript_dir = self._storage_path / self.TRANSCRIPT_DIR
        self._main_file = self._transcript_dir / self.MAIN_FILE
        self._summary_file = self._transcript_dir / self.SUMMARY_FILE

        # DB support (set via set_database) — kept for the operator
        # analytics mirror; will be revisited in GENY-8.
        self._db_manager = None
        self._session_id: Optional[str] = None

        # Executor provider — wired post-construction by AgentSession.
        self._provider: Any = None

    def set_memory_provider(self, provider: Any) -> None:
        self._provider = provider

    def set_database(self, db_manager, session_id: str) -> None:
        """Enable DB-backed mirror for operator analytics."""
        self._db_manager = db_manager
        self._session_id = session_id
        logger.debug("ShortTermMemory: DB backend enabled for session %s", session_id)

    @property
    def _db_available(self) -> bool:
        return self._db_manager is not None and self._session_id is not None

    @property
    def transcript_file(self) -> Path:
        return self._main_file

    # ------------------------------------------------------------------
    # Directory management
    # ------------------------------------------------------------------

    def ensure_directory(self) -> None:
        self._transcript_dir.mkdir(parents=True, exist_ok=True)

    def exists(self) -> bool:
        return self._main_file.exists() and self._main_file.stat().st_size > 0

    # ------------------------------------------------------------------
    # Write — route through executor STMHandle
    # ------------------------------------------------------------------

    def add_message(
        self,
        role: str,
        content: str,
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append a message to the executor-owned transcript."""
        if self._provider is None:
            logger.warning(
                "ShortTermMemory.add_message: no MemoryProvider attached; "
                "skipping append (path-A requires provider).",
            )
            return

        from geny_executor.memory.provider import Turn
        from service.memory.sync_async_bridge import run_coro_sync

        turn = Turn(
            role=role,
            content=content,
            timestamp=datetime.now(_get_tz()),
            metadata=dict(metadata) if metadata else {},
        )
        try:
            run_coro_sync(self._provider.stm().append(turn))
        except Exception:  # noqa: BLE001
            logger.warning(
                "ShortTermMemory.add_message: provider append failed",
                exc_info=True,
            )
            return

        if self._db_available:
            try:
                from service.database.memory_db_helper import db_stm_add_message

                db_stm_add_message(
                    self._db_manager,
                    self._session_id,
                    role=role,
                    content=content,
                    metadata=metadata,
                )
            except Exception as e:
                logger.debug("ShortTermMemory: DB write failed (non-critical): %s", e)

    def add_event(
        self,
        event: str,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Append a non-message event line to the executor-owned transcript."""
        if self._provider is None:
            logger.warning(
                "ShortTermMemory.add_event: no MemoryProvider attached; "
                "skipping append.",
            )
            return

        from service.memory.sync_async_bridge import run_coro_sync

        try:
            run_coro_sync(
                self._provider.stm().append_event(event, dict(data) if data else None)
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "ShortTermMemory.add_event: provider append_event failed",
                exc_info=True,
            )
            return

        if self._db_available:
            try:
                from service.database.memory_db_helper import db_stm_add_event

                db_stm_add_event(
                    self._db_manager,
                    self._session_id,
                    event_name=event,
                    data=data,
                )
            except Exception as e:
                logger.debug("ShortTermMemory: DB event write failed (non-critical): %s", e)

    def write_summary(self, summary: str) -> None:
        """Write the session summary markdown file.

        Stays as direct disk write — `STMHandle` has no summary
        surface (it's a Geny-side cosmetic artefact, not part of the
        canonical conversation transcript).
        """
        self.ensure_directory()
        self._summary_file.write_text(summary, encoding="utf-8")
        logger.debug(
            "ShortTermMemory: wrote summary (%d chars) to %s",
            len(summary), self._summary_file,
        )

        if self._db_available:
            try:
                from service.database.memory_db_helper import db_stm_write_summary

                db_stm_write_summary(self._db_manager, self._session_id, summary)
            except Exception as e:
                logger.debug("ShortTermMemory: DB summary write failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Read — DB first, then executor STMHandle
    # ------------------------------------------------------------------

    def load_all(self) -> List[MemoryEntry]:
        """Load every transcript message as a `MemoryEntry`.

        DB mirror first (richer metadata + cross-session analytics),
        falls back to `provider.stm().recent(_RECENT_LARGE_N)` so the
        result still works when the DB is disabled. Pre-migration
        callers (transcripts controller, memory inspect tools,
        manager.compact_session) keep their existing return shape.
        """
        if self._db_available:
            db_entries = self._load_all_from_db()
            if db_entries is not None:
                return db_entries

        if self._provider is None:
            return []

        from service.memory.sync_async_bridge import run_coro_sync

        try:
            turns = run_coro_sync(self._provider.stm().recent(n=_RECENT_LARGE_N))
        except Exception:  # noqa: BLE001
            logger.debug("ShortTermMemory.load_all: provider recent failed", exc_info=True)
            return []

        entries: List[MemoryEntry] = []
        for i, turn in enumerate(turns):
            entries.append(
                MemoryEntry(
                    source=MemorySource.SHORT_TERM,
                    content=f"[{turn.role}] {_content_to_text(turn.content)}",
                    timestamp=turn.timestamp,
                    filename=str(self._main_file.relative_to(self._storage_path)),
                    line_start=i + 1,
                    line_end=i + 1,
                    metadata={"role": turn.role, **(turn.metadata or {})},
                )
            )
        return entries

    def _load_all_from_db(self) -> Optional[List[MemoryEntry]]:
        try:
            from service.database.memory_db_helper import db_stm_load_all

            rows = db_stm_load_all(self._db_manager, self._session_id)
            if rows is None:
                return None

            entries: List[MemoryEntry] = []
            for i, row in enumerate(rows):
                entry_type = row.get("entry_type", "message")
                role = row.get("role", "unknown")
                content = row.get("content", "")
                ts_str = row.get("entry_timestamp", "")

                timestamp = None
                if ts_str:
                    try:
                        timestamp = datetime.fromisoformat(ts_str)
                    except (ValueError, TypeError):
                        pass

                if entry_type == "message":
                    display = f"[{role}] {content}"
                else:
                    event_name = row.get("event_name", "event")
                    display = f"[event:{event_name}]"

                entries.append(
                    MemoryEntry(
                        source=MemorySource.SHORT_TERM,
                        content=display,
                        timestamp=timestamp,
                        filename=str(self._main_file.relative_to(self._storage_path)),
                        line_start=i + 1,
                        line_end=i + 1,
                        metadata={"role": role, **row.get("metadata", {})},
                    )
                )
            return entries
        except Exception as e:
            logger.debug("ShortTermMemory: DB load_all failed: %s", e)
            return None

    def get_recent(self, n: int = 20) -> List[MemoryEntry]:
        """Load the N most recent messages."""
        if self._db_available:
            db_entries = self._get_recent_from_db(n)
            if db_entries is not None:
                return db_entries

        if self._provider is None:
            return []

        from service.memory.sync_async_bridge import run_coro_sync

        try:
            turns = run_coro_sync(self._provider.stm().recent(n=n))
        except Exception:  # noqa: BLE001
            logger.debug("ShortTermMemory.get_recent: provider recent failed", exc_info=True)
            return []

        return [
            MemoryEntry(
                source=MemorySource.SHORT_TERM,
                content=f"[{turn.role}] {_content_to_text(turn.content)}",
                timestamp=turn.timestamp,
                filename=str(self._main_file.relative_to(self._storage_path)),
                line_start=i + 1,
                line_end=i + 1,
                metadata={"role": turn.role, **(turn.metadata or {})},
            )
            for i, turn in enumerate(turns)
        ]

    def _get_recent_from_db(self, n: int) -> Optional[List[MemoryEntry]]:
        try:
            from service.database.memory_db_helper import db_stm_get_recent

            rows = db_stm_get_recent(self._db_manager, self._session_id, n=n)
            if rows is None:
                return None
            entries: List[MemoryEntry] = []
            for i, row in enumerate(rows):
                role = row.get("role", "unknown")
                content = row.get("content", "")
                ts_str = row.get("entry_timestamp", "")
                timestamp = None
                if ts_str:
                    try:
                        timestamp = datetime.fromisoformat(ts_str)
                    except (ValueError, TypeError):
                        pass
                entries.append(
                    MemoryEntry(
                        source=MemorySource.SHORT_TERM,
                        content=f"[{role}] {content}",
                        timestamp=timestamp,
                        filename=str(self._main_file.relative_to(self._storage_path)),
                        line_start=i + 1,
                        line_end=i + 1,
                        metadata={"role": role, **row.get("metadata", {})},
                    )
                )
            return entries
        except Exception as e:
            logger.debug("ShortTermMemory: DB get_recent failed: %s", e)
            return None

    def get_summary(self) -> Optional[str]:
        """Load the session summary."""
        if self._db_available:
            try:
                from service.database.memory_db_helper import db_stm_get_summary

                summary = db_stm_get_summary(self._db_manager, self._session_id)
                if summary is not None:
                    return summary
            except Exception as e:
                logger.debug("ShortTermMemory: DB get_summary failed: %s", e)

        if not self._summary_file.exists():
            return None
        try:
            return self._summary_file.read_text(encoding="utf-8").strip() or None
        except (OSError, UnicodeDecodeError):
            return None

    def search(
        self,
        query: str,
        *,
        max_results: int = 10,
    ) -> List[MemorySearchResult]:
        """Keyword search over transcript messages."""
        if not query.strip():
            return []

        if self._db_available:
            db_results = self._search_db(query, max_results)
            if db_results is not None and db_results:
                return db_results

        if self._provider is None:
            return []

        from service.memory.sync_async_bridge import run_coro_sync

        try:
            turns = run_coro_sync(
                self._provider.stm().search(query, limit=max_results)
            )
        except Exception:  # noqa: BLE001
            logger.debug("ShortTermMemory.search: provider search failed", exc_info=True)
            return []

        results: List[MemorySearchResult] = []
        for turn in turns:
            content = f"[{turn.role}] {_content_to_text(turn.content)}"
            entry = MemoryEntry(
                source=MemorySource.SHORT_TERM,
                content=content,
                timestamp=turn.timestamp,
                filename=str(self._main_file.relative_to(self._storage_path)),
                metadata={"role": turn.role, **(turn.metadata or {})},
            )
            snippet = content[:240] + "..." if len(content) > 240 else content
            results.append(
                MemorySearchResult(
                    entry=entry,
                    score=1.0,
                    snippet=snippet,
                    match_type="keyword",
                )
            )
        return results

    def _search_db(
        self, query: str, max_results: int,
    ) -> Optional[List[MemorySearchResult]]:
        try:
            from service.database.memory_db_helper import db_stm_search

            db_rows = db_stm_search(
                self._db_manager,
                self._session_id,
                query_text=query,
                max_results=max_results,
            )
            if db_rows is None:
                return None
            results: List[MemorySearchResult] = []
            for row in db_rows:
                content = f"[{row.get('role', 'unknown')}] {row.get('content', '')}"
                ts_str = row.get("entry_timestamp", "")
                timestamp = None
                if ts_str:
                    try:
                        timestamp = datetime.fromisoformat(ts_str)
                    except (ValueError, TypeError):
                        pass
                entry = MemoryEntry(
                    source=MemorySource.SHORT_TERM,
                    content=content,
                    timestamp=timestamp,
                    filename=str(self._main_file.relative_to(self._storage_path)),
                    metadata={"role": row.get("role", ""), **row.get("metadata", {})},
                )
                snippet = content[:240] + "..." if len(content) > 240 else content
                results.append(
                    MemorySearchResult(
                        entry=entry,
                        score=1.0,
                        snippet=snippet,
                        match_type="db_keyword",
                    )
                )
            return results
        except Exception as e:
            logger.debug("ShortTermMemory: DB search failed: %s", e)
            return None

    def message_count(self) -> int:
        """Count total messages in the transcript."""
        if self._db_available:
            try:
                from service.database.memory_db_helper import db_stm_message_count

                count = db_stm_message_count(self._db_manager, self._session_id)
                if count is not None:
                    return int(count)
            except Exception as e:
                logger.debug("ShortTermMemory: DB message_count failed: %s", e)

        return len(self.load_all())


def _content_to_text(content: Any) -> str:
    """Best-effort string projection of `Turn.content`."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        if parts:
            return "\n".join(parts)
    return str(content)
