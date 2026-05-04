"""
Long-term memory — thin adapter over `provider.ltm()` + `provider.notes()`.

Path-A migration GENY-3. The markdown narrative (`memory/MEMORY.md`,
`memory/<YYYY-MM-DD>.md`, `memory/topics/<slug>.md`) and the pinned-
facts directory (`memory/critical/`) are owned by the executor's
`LTMHandle` / `NotesHandle`. This module preserves the legacy
`LongTermMemory` surface that the rest of Geny uses (manager,
strategies, agent_executor) and routes every read/write through the
provider.

Geny still owns:
- DB dual-write mirror (`session_memory_entries`, revisited in GENY-8)
- `memory/executions/<YYYY-MM-DD>.md` append (NotesHandle category;
  Geny chooses the filename + ConversationArchiver-style read+update)
- `MemoryEntry` / `MemorySearchResult` adapter shape
"""

from __future__ import annotations

from datetime import datetime
from logging import getLogger
from pathlib import Path
from typing import Any, List, Optional

from service.memory.types import MemoryEntry, MemorySearchResult, MemorySource

logger = getLogger(__name__)

# Use configured timezone from GENY_TIMEZONE env var
from service.utils.utils import _configured_tz as _get_tz


# Pinned-facts category — kept in sync with structured_writer.PINNED_CATEGORY.
PINNED_CATEGORY = "critical"
# Append-only execution-summary stream lives under this category.
EXECUTIONS_CATEGORY = "executions"


class LongTermMemory:
    """Thin adapter over the executor's LTMHandle + NotesHandle.

    Construction stays compatible with pre-migration call sites
    (`LongTermMemory(storage_path)`); attach the executor provider
    via `set_memory_provider(provider)` once the agent session has
    built it. Provider-less calls become a warning + no-op
    (PR-3g pattern); path A requires a provider to land any disk
    write.
    """

    MEMORY_DIR = "memory"
    MAIN_FILE = "MEMORY.md"
    TOPICS_SUBDIR = "topics"

    def __init__(self, storage_path: str):
        self._storage_path = Path(storage_path)
        self._memory_dir = self._storage_path / self.MEMORY_DIR
        self._main_file = self._memory_dir / self.MAIN_FILE
        self._topics_dir = self._memory_dir / self.TOPICS_SUBDIR

        # Executor provider — wired post-construction by AgentSession.
        self._provider: Any = None

    def set_memory_provider(self, provider: Any) -> None:
        self._provider = provider

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    @property
    def main_file(self) -> Path:
        return self._main_file

    # ------------------------------------------------------------------
    # Directory management
    # ------------------------------------------------------------------

    def ensure_directory(self) -> None:
        self._memory_dir.mkdir(parents=True, exist_ok=True)
        self._topics_dir.mkdir(parents=True, exist_ok=True)

    def exists(self) -> bool:
        return self._main_file.exists() and self._main_file.stat().st_size > 0

    # ------------------------------------------------------------------
    # Writes — route through executor LTMHandle / NotesHandle
    # ------------------------------------------------------------------

    def append(self, text: str, *, heading: Optional[str] = None) -> None:
        """Append durable knowledge to MEMORY.md."""
        if self._provider is None:
            logger.warning(
                "LongTermMemory.append: no MemoryProvider attached; "
                "skipping write (path-A requires provider).",
            )
            return
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            run_coro_sync(self._provider.ltm().append(text, heading=heading))
        except Exception:  # noqa: BLE001
            logger.warning(
                "LongTermMemory.append: provider append failed",
                exc_info=True,
            )

    def write_dated(
        self, text: str, *, date: Optional[datetime] = None,
    ) -> Optional[Path]:
        """Append `text` to `memory/<YYYY-MM-DD>.md` (executor-managed)."""
        if self._provider is None:
            logger.warning(
                "LongTermMemory.write_dated: no MemoryProvider attached; skipping",
            )
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            ref = run_coro_sync(self._provider.ltm().write_dated(text, day=date))
        except Exception:  # noqa: BLE001
            logger.warning(
                "LongTermMemory.write_dated: provider write_dated failed",
                exc_info=True,
            )
            return None
        return self._memory_dir / ref.filename if ref and ref.filename else None

    def write_topic(self, topic: str, text: str) -> Optional[Path]:
        """Write a topic-specific markdown file (`memory/topics/<slug>.md`)."""
        if self._provider is None:
            logger.warning(
                "LongTermMemory.write_topic: no MemoryProvider attached; skipping",
            )
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            ref = run_coro_sync(self._provider.ltm().write_topic(topic, text))
        except Exception:  # noqa: BLE001
            logger.warning(
                "LongTermMemory.write_topic: provider write_topic failed",
                exc_info=True,
            )
            return None
        return self._memory_dir / ref.filename if ref and ref.filename else None

    def write_execution(
        self, entry: str, *, date: Optional[datetime] = None,
    ) -> Optional[str]:
        """Append `entry` to `memory/executions/<YYYY-MM-DD>.md`.

        Routed through `NotesHandle` (category="executions") so the
        per-day file is owned by the executor like every other note.
        New file → `notes.write` with the date as the filename;
        existing file → `notes.update(append_body=...)` so the
        executor's atomic write keeps the disk consistent.
        """
        if self._provider is None:
            logger.warning(
                "LongTermMemory.write_execution: no MemoryProvider attached",
            )
            return None
        from geny_executor.memory.provider import (
            Importance,
            NoteDraft,
            NotePatch,
            Scope,
        )
        from service.memory.sync_async_bridge import run_coro_sync

        ts = date or datetime.now(_get_tz())
        day = ts.date().isoformat()
        bare_filename = f"{day}.md"
        notes = self._provider.notes()
        try:
            existing = run_coro_sync(notes.read(bare_filename))
        except Exception:  # noqa: BLE001
            logger.debug(
                "LongTermMemory.write_execution: provider read failed",
                exc_info=True,
            )
            existing = None

        try:
            if existing is None:
                draft = NoteDraft(
                    title=f"Executions {day}",
                    body=entry.rstrip() + "\n",
                    category=EXECUTIONS_CATEGORY,
                    tags=["execution"],
                    importance=Importance.MEDIUM,
                    scope=Scope.SESSION,
                    filename=bare_filename,
                    metadata={
                        "geny.kind": "executions_journal",
                        "geny.day": day,
                    },
                )
                run_coro_sync(notes.write(draft))
            else:
                patch = NotePatch(append_body=entry.rstrip())
                run_coro_sync(notes.update(bare_filename, patch))
        except Exception:  # noqa: BLE001
            logger.warning(
                "LongTermMemory.write_execution: provider write/update failed",
                exc_info=True,
            )
            return None
        return f"{EXECUTIONS_CATEGORY}/{bare_filename}"

    # ------------------------------------------------------------------
    # Reads — DB first, then executor LTMHandle / NotesHandle
    # ------------------------------------------------------------------

    def load_main(self) -> Optional[MemoryEntry]:
        """Load `MEMORY.md` content."""
        if self._provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            text = run_coro_sync(self._provider.ltm().read_main())
        except Exception:  # noqa: BLE001
            logger.debug(
                "LongTermMemory.load_main: provider read failed",
                exc_info=True,
            )
            return None
        if not text:
            return None
        return MemoryEntry(
            source=MemorySource.LONG_TERM,
            content=text,
            timestamp=None,
            filename=self.MAIN_FILE,
            metadata={"category": "root"},
        )

    def load_pinned(
        self,
        *,
        max_chars: int = 3000,
    ) -> Optional[MemoryEntry]:
        """Load all pinned-facts (`memory/critical/`) into one entry."""
        if self._provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            body = run_coro_sync(
                self._provider.notes().load_pinned(
                    category=PINNED_CATEGORY,
                    max_chars=max_chars,
                )
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "LongTermMemory.load_pinned: provider load_pinned failed",
                exc_info=True,
            )
            return None
        if not body:
            return None
        return MemoryEntry(
            source=MemorySource.LONG_TERM,
            content=body,
            timestamp=None,
            filename=f"{PINNED_CATEGORY}/",
            category=PINNED_CATEGORY,
            tags=["pinned"],
            importance="critical",
            metadata={"pinned": True},
        )

    def load_all(self) -> List[MemoryEntry]:
        """Load every LTM markdown file. Used by compaction.

        The executor's `LTMHandle` doesn't expose a dump-everything
        call (out of scope for the protocol); we read the markdown
        files directly under `memory/` since the layout is shared
        with the executor.
        """
        entries: List[MemoryEntry] = []
        if not self._memory_dir.exists():
            return entries
        for path in sorted(self._memory_dir.rglob("*.md")):
            if path.name in ("_index.json", "_vault_map.json"):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if not text.strip():
                continue
            try:
                rel = str(path.relative_to(self._memory_dir))
            except ValueError:
                rel = path.name
            entries.append(
                MemoryEntry(
                    source=MemorySource.LONG_TERM,
                    content=text,
                    timestamp=None,
                    filename=rel,
                    metadata={"path": str(path)},
                )
            )
        return entries

    def search(
        self,
        query: str,
        *,
        max_results: int = 10,
    ) -> List[MemorySearchResult]:
        """Keyword + embedding search via executor LTMHandle."""
        if not query.strip() or self._provider is None:
            return []
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            chunks = run_coro_sync(
                self._provider.ltm().search(query, limit=max_results)
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "LongTermMemory.search: provider search failed",
                exc_info=True,
            )
            return []

        results: List[MemorySearchResult] = []
        for chunk in chunks:
            entry = MemoryEntry(
                source=MemorySource.LONG_TERM,
                content=chunk.content,
                timestamp=None,
                filename=chunk.key,
                metadata=dict(chunk.metadata or {}),
            )
            snippet = (
                chunk.content[:240] + "..." if len(chunk.content) > 240 else chunk.content
            )
            results.append(
                MemorySearchResult(
                    entry=entry,
                    score=float(chunk.relevance_score or 0.0),
                    snippet=snippet,
                    match_type=str(chunk.source or "ltm"),
                )
            )
        return results
