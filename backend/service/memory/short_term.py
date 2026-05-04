"""
Short-term memory — thin adapter over `provider.stm()`.

Path-A migration GENY-1 + GENY-9: every read and write goes through
the executor's `STMHandle`. The DB analytics mirror was retired in
GENY-9 along with the equivalent in LongTermMemory; the disk jsonl
+ executor's snapshot are the only source of truth.

Layout (executor-owned)::

    <storage_path>/
        transcripts/
            session.jsonl       ← executor.STMHandle (append/recent/search)
            summary.md          ← Geny side (executor STM has no summary surface)
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
    are no-ops + warning if no provider is attached.
    """

    TRANSCRIPT_DIR = "transcripts"
    MAIN_FILE = "session.jsonl"
    SUMMARY_FILE = "summary.md"

    def __init__(self, storage_path: str):
        self._storage_path = Path(storage_path)
        self._transcript_dir = self._storage_path / self.TRANSCRIPT_DIR
        self._main_file = self._transcript_dir / self.MAIN_FILE
        self._summary_file = self._transcript_dir / self.SUMMARY_FILE

        # Executor provider — wired post-construction by AgentSession.
        self._provider: Any = None

    def set_memory_provider(self, provider: Any) -> None:
        self._provider = provider

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

    def write_summary(self, summary: str) -> None:
        """Write the session summary markdown file."""
        self.ensure_directory()
        self._summary_file.write_text(summary, encoding="utf-8")
        logger.debug(
            "ShortTermMemory: wrote summary (%d chars) to %s",
            len(summary), self._summary_file,
        )

    # ------------------------------------------------------------------
    # Read — executor STMHandle is the single source
    # ------------------------------------------------------------------

    def load_all(self) -> List[MemoryEntry]:
        """Load every transcript message as a `MemoryEntry`."""
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

    def get_recent(self, n: int = 20) -> List[MemoryEntry]:
        """Load the N most recent messages."""
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

    def get_summary(self) -> Optional[str]:
        """Load the session summary."""
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
        """Keyword search over transcript messages via executor STMHandle."""
        if not query.strip() or self._provider is None:
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

    def message_count(self) -> int:
        """Count total messages in the transcript."""
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
