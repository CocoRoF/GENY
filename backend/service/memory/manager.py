"""
Session Memory Manager — unified facade.

Each session gets its own SessionMemoryManager tied to its
``storage_path``. The manager calls the executor's
``MemoryProvider`` directly through inline helper methods —
host-side STM / LTM adapter classes were retired in 1.21.0
(``ShortTermMemory``) and Sprint 3 step 2 (``LongTermMemory``).

It handles:
  - Unified search across STM + LTM + vector
  - Memory injection for prompts (build context string)
  - Memory flush before compaction (save durable facts)
  - Statistics
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from service.memory.vector_memory import VectorSearchResult
from service.memory.structured_writer import StructuredMemoryWriter
from service.memory.index import (
    MemoryFileInfo,
    MemoryIndex,
    _CATEGORY_DESCRIPTIONS,
)
from service.memory.types import (
    MemoryEntry,
    MemorySearchResult,
    MemorySource,
    MemoryStats,
)

logger = getLogger(__name__)

# Use configured timezone from GENY_TIMEZONE env var
from service.utils.utils import _configured_tz as _get_tz

# Maximum characters injected from memory into context.
DEFAULT_MAX_INJECT_CHARS = 8_000

# Maximum chars for truncated fields in LTM entries.
_LTM_INPUT_PREVIEW = 300
_LTM_OUTPUT_PREVIEW = 800
_LTM_TODO_RESULT_PREVIEW = 400

# Bound for `_stm_load_all` — same as the legacy `ShortTermMemory`
# adapter used. Keeps memory inspect tools from accidentally pulling
# the entire session history when a session has thousands of turns.
_RECENT_LARGE_N = 5000


def _content_to_text(content: Any) -> str:
    """Render `Turn.content` as a flat string. Mirrors what the
    retired `ShortTermMemory._content_to_text` helper produced."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
                elif block.get("type") == "tool_use":
                    parts.append(f"[tool_use:{block.get('name', '?')}]")
                elif block.get("type") == "tool_result":
                    parts.append(f"[tool_result:{block.get('tool_use_id', '?')}]")
                else:
                    parts.append(str(block))
            else:
                parts.append(str(block))
        return "\n".join(p for p in parts if p)
    try:
        import json as _json

        return _json.dumps(content, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(content)


class SessionMemoryManager:
    """Per-session memory facade.

    Usage::

        mgr = SessionMemoryManager(storage_path="/tmp/sessions/abc123")
        mgr.initialize()

        # Record conversation
        mgr.record_message("user", "Fix the login bug")
        mgr.record_message("assistant", "I'll look into auth.py...")

        # Save durable knowledge
        mgr.remember("The login bug was caused by expired JWT tokens.")

        # Search across all memory
        results = mgr.search("JWT token")

        # Build injection block for system prompt
        context = mgr.build_memory_context(query="JWT")
    """

    def __init__(
        self,
        storage_path: str,
        max_inject_chars: int = DEFAULT_MAX_INJECT_CHARS,
        *,
        session_id: str = "",
    ):
        """
        Args:
            storage_path: Session's root storage directory.
            max_inject_chars: Budget for memory injection into context.
            session_id: Logical session id used in archiver filenames
                (``conversations/<sid>__<bucket>.md``) and DB rows.
                Optional for back-compat — when omitted the archivers
                fall back to ``"unknown"`` slugs and the DB writes
                stay disabled until ``set_database`` provides one.
                Cycle 20260503_5 — this used to be ``None`` and only
                set later by ``set_database``, which meant non-DB
                sessions produced ``conversations/unknown__*.md``
                forever.
        """
        self._storage_path = storage_path
        self._max_inject_chars = max_inject_chars

        # STM + LTM both go through the executor `MemoryProvider`
        # directly — the legacy `ShortTermMemory` (retired 1.21.0)
        # and `LongTermMemory` (retired Sprint 3 step 2) adapters
        # are gone. Inline helpers on this class (``_stm_*`` /
        # ``_ltm_*``) wrap the async provider calls in
        # ``run_coro_sync`` so the rest of the manager keeps its
        # synchronous surface.
        self._memory_provider: Optional[Any] = None
        self._transcript_dir = Path(storage_path) / "transcripts"
        self._stm_jsonl = self._transcript_dir / "session.jsonl"
        self._stm_summary_path = self._transcript_dir / "summary.md"
        self._memory_dir = Path(storage_path) / "memory"
        self._ltm_main_file = self._memory_dir / "MEMORY.md"
        # Vector access goes through the provider directly via inline
        # ``_vmm_*`` helpers — no host-side ``VectorMemoryManager``
        # stored on the manager (Sprint 3 step 3 retired it from the
        # session manager). The adapter class itself stays in
        # ``service/memory/vector_memory.py`` for ``curated_knowledge``
        # which constructs its own per-user vector store; that wiring
        # is retired in step 3.5.

        # Structured memory layer (Obsidian-like).
        # The legacy ``MemoryIndexManager`` adapter was retired in
        # Sprint 3 step 4. Index reads/rebuilds route directly through
        # ``provider.index()`` via inline ``_index_*`` helpers below;
        # the host no longer caches the snapshot.
        self._structured_writer: Optional[StructuredMemoryWriter] = None

        # Memory v2 — leaf source-of-truth writer (plan §1.5).
        # Auto-archives every record_message into
        # ``memory/conversations/<date>/<id>.md``. Lazy-built in
        # ``initialize()`` so callers that only construct the manager
        # without initialising it (rare; old tests) don't hit disk.
        from service.memory.conversation_archiver import ConversationArchiver  # local
        from service.memory.dm_archiver import DmArchiver
        from service.memory.compaction_archiver import CompactionArchiver
        # Cycle 20260503_6 — DailyJournalWriter retired. ``conversations/``
        # rollup files now carry every turn (with date_first/date_last
        # in frontmatter for chronological filtering), and the
        # standalone ``memory/<YYYY-MM-DD>.md`` headline index was
        # 100% redundant with the conversations sidebar entries.
        self._ConversationArchiver = ConversationArchiver
        self._DmArchiver = DmArchiver
        self._CompactionArchiver = CompactionArchiver
        self._conversation_archiver: Optional[ConversationArchiver] = None
        self._dm_archiver: Optional[DmArchiver] = None
        self._compaction_archiver: Optional[CompactionArchiver] = None

        self._initialized = False
        self._db_manager = None
        # Stored as Optional[str] for back-compat with code paths that
        # checked ``is None``. New construction defaults to "" via the
        # constructor kwarg so archiver filenames carry a real id.
        self._session_id: Optional[str] = session_id or None

    def set_memory_provider(self, provider) -> None:
        """Plug the executor `MemoryProvider` into every layer that
        speaks to it.

        Called by `AgentSession` immediately after the composite
        provider is built. Consumers:

        - `ShortTermMemory`: append / recent / search route through
          `provider.stm()` (GENY-1, path A migration). DB dual-write
          stays as analytics mirror; cosmetic `summary.md` stays as
          direct disk write.
        - `VectorMemoryManager`: vector retrieval + indexing route
          through `provider.vector()`.
        - `StructuredMemoryWriter`: write / update / delete / link /
          read / list route through `provider.notes()`.
        - `ConversationArchiver`: per-session rollup route through
          `provider.notes()` (single-level filename within
          `memory/conversations/`).
        - `CompactionArchiver`: compaction vault writes route
          through `provider.notes()`. The audit copy under
          `transcripts/compactions/` keeps its direct disk path.

        DM archiver intentionally stays on direct atomic-write —
        its `dms/<cp>/<date>.md` layout has a counterpart subdir
        which the executor's flat-category NotesHandle doesn't
        model.
        """
        # Cache the provider on the manager so the inline ``_stm_*`` /
        # ``_ltm_*`` helpers can route every operation through
        # ``provider.stm()`` / ``provider.ltm()`` / ``provider.notes()``.
        self._memory_provider = provider
        if self._structured_writer is not None:
            self._structured_writer.set_memory_provider(provider)
        if self._compaction_archiver is not None:
            try:
                self._compaction_archiver.set_memory_provider(provider)
            except Exception:  # noqa: BLE001
                logger.debug(
                    "set_memory_provider: compaction wiring skipped",
                    exc_info=True,
                )
        # DM archiver stays on direct atomic-write — its
        # `dms/<cp>/<date>.md` layout has a counterpart subdir which
        # the executor's flat-category NotesHandle doesn't model.
        if self._conversation_archiver is not None and hasattr(
            self._conversation_archiver, "set_memory_provider"
        ):
            try:
                self._conversation_archiver.set_memory_provider(provider)
            except Exception:  # noqa: BLE001
                logger.debug(
                    "set_memory_provider: conversation archiver wiring skipped",
                    exc_info=True,
                )

    def set_database(self, db_manager, session_id: str) -> None:
        """Enable DB-backed persistence for LTM and STM.

        Args:
            db_manager: AppDatabaseManager instance.
            session_id: Session ID for DB queries.
        """
        self._db_manager = db_manager
        self._session_id = session_id
        # GENY-9 — STM/LTM/structured_writer no longer dual-write to
        # the DB analytics mirror; their writes route through
        # `provider.stm()` / `provider.ltm()` / `provider.notes()`
        # exclusively. The manager keeps `_db_manager` because
        # `compute_memory_stats` still aggregates from it for the
        # operator dashboards. Late `set_database` calls now only
        # refresh the archivers' `session_id` (legacy fix from cycle
        # 20260503_5 — archivers used to bind None at init time).
        for archiver_attr in (
            "_conversation_archiver",
            "_dm_archiver",
            "_compaction_archiver",
        ):
            archiver = getattr(self, archiver_attr, None)
            if archiver is None:
                continue
            try:
                archiver.set_session_id(session_id)
            except AttributeError:
                # Older archiver build without setter — leave it alone.
                pass
        logger.info("SessionMemoryManager: DB backend enabled for session %s", session_id)

    # NOTE: the ``long_term`` property was retired in Sprint 3 step 2
    # along with the ``LongTermMemory`` adapter. Callers go through
    # the manager's public LTM surface
    # (``remember`` / ``remember_dated`` / ``remember_topic`` / `search`).

    # NOTE: the ``short_term`` property was retired in 1.21.0 along with
    # the ``ShortTermMemory`` adapter. Callers that previously did
    # ``mgr.short_term.load_all()`` should call ``mgr.load_all_stm()``
    # (kept on the manager as the public read surface).

    # NOTE: the ``vector_memory`` property was retired in Sprint 3
    # step 3 along with the ``VectorMemoryManager`` field on the
    # manager. Inline ``_vector_*`` helpers route through
    # ``provider.vector()``.

    # NOTE: the ``index_manager`` property was retired in Sprint 3
    # step 4 along with the ``MemoryIndexManager`` field on the
    # manager. Inline ``_index_*`` helpers route through
    # ``provider.index()``; callers that previously did
    # ``mgr.index_manager.build_vault_map()`` should call
    # ``mgr.build_vault_map()``.

    @property
    def structured_writer(self) -> Optional[StructuredMemoryWriter]:
        return self._structured_writer

    @property
    def storage_path(self) -> str:
        return self._storage_path

    # ------------------------------------------------------------------
    # STM helpers (1.21.0 — provider direct, no host adapter)
    #
    # Each helper wraps the executor's async ``STMHandle`` in a sync
    # call via ``run_coro_sync`` so the rest of the manager keeps its
    # synchronous surface. Type conversion (Turn → MemoryEntry,
    # Turn → MemorySearchResult) happens inline.
    # ------------------------------------------------------------------

    def _stm_append_message(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if self._memory_provider is None:
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
            run_coro_sync(self._memory_provider.stm().append(turn))
        except Exception:  # noqa: BLE001
            logger.warning(
                "manager._stm_append_message: provider.stm().append failed",
                exc_info=True,
            )

    def _stm_append_event(
        self,
        event: str,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        if self._memory_provider is None:
            return
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            run_coro_sync(
                self._memory_provider.stm().append_event(
                    event, dict(data) if data else None
                )
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "manager._stm_append_event: provider.stm().append_event failed",
                exc_info=True,
            )

    def _stm_get_summary(self) -> Optional[str]:
        if self._memory_provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            text = run_coro_sync(self._memory_provider.stm().read_summary())
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._stm_get_summary: provider.stm().read_summary failed",
                exc_info=True,
            )
            return None
        if not text:
            return None
        return text.strip() or None

    def _stm_write_summary(self, body: str) -> None:
        if self._memory_provider is None:
            return
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            run_coro_sync(self._memory_provider.stm().write_summary(body))
        except Exception:  # noqa: BLE001
            logger.warning(
                "manager._stm_write_summary: provider.stm().write_summary failed",
                exc_info=True,
            )

    def _stm_get_recent(self, n: int) -> List[MemoryEntry]:
        if self._memory_provider is None or n <= 0:
            return []
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            turns = run_coro_sync(self._memory_provider.stm().recent(n=n))
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._stm_get_recent: provider.stm().recent failed",
                exc_info=True,
            )
            return []
        return [self._turn_to_entry(turn, idx=i) for i, turn in enumerate(turns)]

    def _stm_load_all(self) -> List[MemoryEntry]:
        # Bounded large-N read — same shape `ShortTermMemory.load_all`
        # used to return.
        return self._stm_get_recent(_RECENT_LARGE_N)

    def _stm_search(
        self,
        query: str,
        max_results: int = 10,
    ) -> List[MemorySearchResult]:
        if not query or not query.strip() or self._memory_provider is None:
            return []
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            turns = run_coro_sync(
                self._memory_provider.stm().search(query, limit=max_results)
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._stm_search: provider.stm().search failed",
                exc_info=True,
            )
            return []
        results: List[MemorySearchResult] = []
        for turn in turns:
            entry = self._turn_to_entry(turn)
            content = entry.content
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

    def _turn_to_entry(self, turn: Any, *, idx: int = 0) -> MemoryEntry:
        """Convert an executor `Turn` into the host-side `MemoryEntry`."""
        content_text = _content_to_text(turn.content)
        role = getattr(turn, "role", "user") or "user"
        try:
            transcript_rel = str(self._stm_jsonl.relative_to(self._storage_path))
        except ValueError:
            transcript_rel = "transcripts/session.jsonl"
        return MemoryEntry(
            source=MemorySource.SHORT_TERM,
            content=f"[{role}] {content_text}",
            timestamp=getattr(turn, "timestamp", None),
            filename=transcript_rel,
            line_start=idx + 1,
            line_end=idx + 1,
            metadata={"role": role, **(getattr(turn, "metadata", None) or {})},
        )

    # Public read surface that legacy callers
    # (``memory_inspect_tools._stm_load_all``) can reach for. Keeps
    # the post-1.21.0 surface deliberately small — no parallel
    # ``ShortTermMemory`` object to expose.
    def load_all_stm(self) -> List[MemoryEntry]:
        return self._stm_load_all()

    def get_recent_stm(self, n: int = 20) -> List[MemoryEntry]:
        return self._stm_get_recent(n)

    # ------------------------------------------------------------------
    # LTM helpers (Sprint 3 step 2 — provider direct, no host adapter)
    # ------------------------------------------------------------------

    def _ltm_append(self, text: str, *, heading: Optional[str] = None) -> None:
        if self._memory_provider is None:
            return
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            run_coro_sync(self._memory_provider.ltm().append(text, heading=heading))
        except Exception:  # noqa: BLE001
            logger.warning(
                "manager._ltm_append: provider.ltm().append failed",
                exc_info=True,
            )

    def _ltm_write_topic(self, topic: str, text: str) -> Optional[Path]:
        if self._memory_provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            ref = run_coro_sync(self._memory_provider.ltm().write_topic(topic, text))
        except Exception:  # noqa: BLE001
            logger.warning(
                "manager._ltm_write_topic: provider.ltm().write_topic failed",
                exc_info=True,
            )
            return None
        if ref and ref.filename:
            return self._memory_dir / ref.filename
        return None

    def _ltm_write_execution(
        self, entry: str, *, date: Optional[datetime] = None
    ) -> Optional[str]:
        """Append an execution-summary line to ``memory/executions/<YYYY-MM-DD>.md``.

        Routed through ``NotesHandle`` (category="executions") — new
        file → ``notes.write``; existing → ``notes.update(append_body=...)``.
        Returns ``"executions/<file>.md"`` on success.
        """
        if self._memory_provider is None:
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
        notes = self._memory_provider.notes()
        try:
            existing = run_coro_sync(notes.read(bare_filename))
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._ltm_write_execution: provider read failed",
                exc_info=True,
            )
            existing = None
        try:
            if existing is None:
                draft = NoteDraft(
                    title=f"Executions {day}",
                    body=entry.rstrip() + "\n",
                    category="executions",
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
                "manager._ltm_write_execution: provider write/update failed",
                exc_info=True,
            )
            return None
        return f"executions/{bare_filename}"

    def _ltm_load_main(self) -> Optional[MemoryEntry]:
        if self._memory_provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            text = run_coro_sync(self._memory_provider.ltm().read_main())
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._ltm_load_main: provider read failed",
                exc_info=True,
            )
            return None
        if not text:
            return None
        return MemoryEntry(
            source=MemorySource.LONG_TERM,
            content=text,
            timestamp=None,
            filename="MEMORY.md",
            metadata={"category": "root"},
        )

    def _ltm_load_pinned(self, *, max_chars: int = 3000) -> Optional[MemoryEntry]:
        if self._memory_provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            body = run_coro_sync(
                self._memory_provider.notes().load_pinned(
                    category="critical",
                    max_chars=max_chars,
                )
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._ltm_load_pinned: provider load_pinned failed",
                exc_info=True,
            )
            return None
        if not body:
            return None
        return MemoryEntry(
            source=MemorySource.LONG_TERM,
            content=body,
            timestamp=None,
            filename="critical/",
            category="critical",
            tags=["pinned"],
            importance="critical",
            metadata={"pinned": True},
        )

    def _ltm_search(
        self, query: str, *, max_results: int = 10
    ) -> List[MemorySearchResult]:
        if not query.strip() or self._memory_provider is None:
            return []
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            chunks = run_coro_sync(
                self._memory_provider.ltm().search(query, limit=max_results)
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._ltm_search: provider.ltm().search failed",
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

    # ------------------------------------------------------------------
    # Vector helpers (Sprint 3 step 3 — provider direct)
    # ------------------------------------------------------------------

    @property
    def _vector_enabled(self) -> bool:
        return (
            self._memory_provider is not None
            and self._memory_provider.vector() is not None
        )

    async def _vector_initialize_and_index(self) -> bool:
        """Index every existing markdown note into the vector store.

        Mirror of the legacy ``VectorMemoryManager.initialize() +
        index_memory_files()`` flow. New writes are auto-vectored by
        the executor's ``_FilesystemNotesStore.attach_vector_indexer``
        — this method exists so a session whose disk already carries
        notes (e.g. resumed session) gets those rows into the vector
        store on boot.
        """
        if not self._vector_enabled or self._memory_provider is None:
            return False
        notes_handle = self._memory_provider.notes()
        vector_handle = self._memory_provider.vector()
        try:
            metas = await notes_handle.list()
            items: List = []
            for m in metas:
                note = await notes_handle.read(m.ref.filename)
                if note is None or not note.body:
                    continue
                items.append((note.ref, note.body))
            if items:
                await vector_handle.index_batch(items)
        except Exception:  # noqa: BLE001
            logger.warning(
                "manager._vector_initialize_and_index failed",
                exc_info=True,
            )
            return False
        return True

    async def _vector_index_text(self, text: str, source_filename: str) -> int:
        if not self._vector_enabled or self._memory_provider is None or not text:
            return 0
        from geny_executor.memory.provider import NoteRef, Scope

        ref = NoteRef(
            filename=source_filename,
            scope=Scope.SESSION,
            backend="filesystem",
        )
        try:
            return await self._memory_provider.vector().index(ref, text)
        except Exception:  # noqa: BLE001
            logger.warning(
                "manager._vector_index_text failed (source=%s)",
                source_filename, exc_info=True,
            )
            return 0

    async def _vector_search(
        self, query: str, *, top_k: int = 6
    ) -> List["VectorSearchResult"]:
        if not self._vector_enabled or self._memory_provider is None or not query:
            return []
        try:
            chunks = await self._memory_provider.vector().search(query, top_k=top_k)
        except Exception:  # noqa: BLE001
            logger.warning("manager._vector_search failed", exc_info=True)
            return []
        out: List[VectorSearchResult] = []
        for chunk in chunks:
            meta = dict(chunk.metadata or {})
            out.append(
                VectorSearchResult(
                    text=chunk.content,
                    source_file=chunk.key,
                    score=float(chunk.relevance_score),
                    chunk_index=int(meta.get("chunk_index", 0)),
                    metadata=meta,
                )
            )
        return out

    @staticmethod
    def _vector_build_context(
        results: List["VectorSearchResult"],
        *,
        max_chars: int = 5000,
    ) -> str:
        """Render vector hits as the XML block the prompt builder
        injects (was ``VectorMemoryManager.build_vector_context``)."""
        if not results:
            return ""
        parts: List[str] = []
        total = 0
        for r in results:
            block = (
                f'<vector-memory source="{r.source_file}" '
                f'score="{r.score:.3f}" chunk="{r.chunk_index}">\n'
                f"{r.text}\n"
                f"</vector-memory>"
            )
            if total + len(block) > max_chars and parts:
                break
            parts.append(block)
            total += len(block)
        return "\n\n".join(parts)

    def _ltm_load_all(self) -> List[MemoryEntry]:
        """Load every LTM markdown file. Used by compaction.

        Reads ``memory/`` directly since the executor's `LTMHandle`
        doesn't expose a dump-everything call (out of scope for the
        protocol) — and the on-disk layout is shared with the executor.
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

    # ------------------------------------------------------------------
    # Index helpers (Sprint 3 step 4 — provider direct, no host adapter)
    #
    # ``MemoryIndexManager`` was retired; index reads route through
    # ``provider.index()`` directly. Each helper wraps the executor's
    # async ``IndexHandle`` in a sync call via ``run_coro_sync`` and
    # rehydrates the snapshot into ``MemoryIndex`` / ``MemoryFileInfo``
    # so callers (memory API, opsidian routes, memory_inspect tools)
    # keep their existing shape.
    # ------------------------------------------------------------------

    def _index_snapshot(self) -> MemoryIndex:
        """Lazy snapshot of the executor's IndexHandle.
        Returns an empty `MemoryIndex` when no provider is attached.
        """
        if self._memory_provider is None:
            return MemoryIndex()
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            payload = run_coro_sync(self._memory_provider.index().snapshot())
        except Exception:  # noqa: BLE001
            logger.debug("manager._index_snapshot: provider call failed", exc_info=True)
            return MemoryIndex()

        files: Dict[str, MemoryFileInfo] = {}
        for fname, entry in (payload.get("files") or {}).items():
            files[fname] = MemoryFileInfo.from_dict(entry)
        tag_map = {
            tag: list(names) for tag, names in (payload.get("tag_map") or {}).items()
        }
        link_graph = {
            src: list(targets)
            for src, targets in (payload.get("link_graph") or {}).items()
        }
        return MemoryIndex(
            files=files,
            tag_map=tag_map,
            link_graph=link_graph,
            last_rebuilt=str(payload.get("last_rebuilt", "")),
            total_chars=int(payload.get("total_chars", 0) or 0),
            total_files=int(payload.get("total_files", len(files)) or len(files)),
        )

    def _index_rebuild(self) -> int:
        """Force a fresh index rebuild on the executor side.
        Returns the post-rebuild total_files count (0 if no provider).
        """
        if self._memory_provider is None:
            return 0
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            run_coro_sync(self._memory_provider.index().rebuild())
        except Exception:  # noqa: BLE001
            logger.debug("manager._index_rebuild: provider rebuild failed", exc_info=True)
        return self._index_snapshot().total_files

    def _index_build_vault_map(self) -> Dict[str, Any]:
        """Build the vault map payload (categories, top tags, recently
        modified, MEMORY.md preview). Geny's category descriptions are
        injected so the executor's render matches the legacy
        operator-prompt layout. Returns an empty payload when the
        provider isn't attached.
        """
        if self._memory_provider is None:
            return {
                "categories": {},
                "top_tags": [],
                "recently_modified": [],
                "memory_md_preview": "",
                "total_files": 0,
                "generated_at": datetime.now(_get_tz()).isoformat(),
            }
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            return run_coro_sync(
                self._memory_provider.index().build_vault_map(
                    category_descriptions=_CATEGORY_DESCRIPTIONS,
                )
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "manager._index_build_vault_map: provider call failed",
                exc_info=True,
            )
            return {
                "categories": {},
                "top_tags": [],
                "recently_modified": [],
                "memory_md_preview": "",
                "total_files": 0,
                "generated_at": datetime.now(_get_tz()).isoformat(),
            }

    def build_vault_map(self) -> Dict[str, Any]:
        """Public surface for the vault map render.

        Replaces the retired ``mgr.index_manager.build_vault_map()``
        call site. Memory tools (`memory_categories`) and any other
        operator-facing surface that previously reached for the index
        manager should call this method instead.
        """
        return self._index_build_vault_map()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def initialize(self) -> None:
        """Set up directory structure for both memory stores."""
        self._memory_dir.mkdir(parents=True, exist_ok=True)
        (self._memory_dir / "topics").mkdir(parents=True, exist_ok=True)
        # transcripts/ dir is created by the executor's STM store on
        # the first append; nothing to do here.
        self._transcript_dir.mkdir(parents=True, exist_ok=True)

        # Initialize structured memory layer.
        # Sprint 3 step 4 — ``MemoryIndexManager`` retired; writers no
        # longer receive a host-side index handle. The executor's
        # IndexHandle refreshes ``_index.json`` / per-category shards /
        # ``_summary.json`` automatically on every ``NotesStore.write``
        # (1.20.0 EXEC-5), so the host has nothing to invalidate.
        memory_dir = self._memory_dir
        self._structured_writer = StructuredMemoryWriter(
            str(memory_dir),
            session_id=self._session_id or "",
        )
        self._conversation_archiver = self._ConversationArchiver(
            str(memory_dir),
            session_id=self._session_id or "",
        )
        self._dm_archiver = self._DmArchiver(
            str(memory_dir),
            session_id=self._session_id or "",
        )
        # PR 8 — compaction archiver. Takes the session storage_path
        # (not memory_dir) because it writes to two locations:
        # ``transcripts/compactions/`` (audit) and
        # ``memory/compactions/`` (vault).
        self._compaction_archiver = self._CompactionArchiver(
            self._storage_path,
            session_id=self._session_id or "",
        )
        # GENY-7b/8 — `StructuredMemoryWriter` no longer has a DB
        # dual-write path; the disk via `provider.notes()` is the
        # single truth. STM/LTM keep their analytics mirrors for now
        # (revisited in GENY-9).

        # Path-A migration GENY-7c — `MemoryMigrator` retired. The
        # plan explicitly opted out of legacy-data migration; new
        # sessions land in the executor-owned layout from the start.

        self._initialized = True
        logger.info("SessionMemoryManager initialized at %s", self._storage_path)

    async def initialize_vector_memory(self) -> bool:
        """Initialise the FAISS vector memory layer (async).

        Called separately from :meth:`initialize` because it requires
        async I/O for config loading and initial indexing.

        Returns:
            ``True`` if vector memory was enabled and initialised.
        """
        try:
            return await self._vector_initialize_and_index()
        except Exception:
            logger.warning(
                "initialize_vector_memory failed (non-critical)",
                exc_info=True,
            )
            return False

    # ------------------------------------------------------------------
    # Write operations (convenience wrappers)
    # ------------------------------------------------------------------

    def record_message(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
        **extra: Any,
    ) -> None:
        """Record a conversation message to short-term memory.

        Cycle 20260430_2 added the canonical *InteractionEvent* schema
        (``service.memory.interaction_event.make_event_metadata``).
        Callers pass the helper's output as ``metadata=...``; the legacy
        variadic ``**extra`` form is kept as a backwards-compat tail
        for the very small number of pre-cycle call sites that pass
        bare kwargs (none in current code, but the door stays open).
        Both forms merge into a single dict; ``extra`` losers ties on
        key collisions so explicit ``metadata`` always wins.

        The cycle-20260430_3 ``entities/<sanitized>.md`` auto-bootstrap
        was retired in Memory v2 (post-1.11): counterpart info now
        lives entirely under ``dms/<cp>/<date>.md`` (per-counterpart-
        per-day index) plus the StreamTab UI, and ``memory_distill``
        writes to ``insights/counterpart-<id>.md`` on demand.

        Args:
            role: "user" | "assistant" | "system" | "internal_trigger"
                | "assistant_dm" — see ``_classify_input_role``.
            content: Message content.
            metadata: Optional structured metadata dict (e.g. the output
                of ``make_event_metadata``).
            **extra: Legacy variadic metadata kwargs.
        """
        meta: Dict[str, Any] = {}
        if extra:
            meta.update(extra)
        if metadata:
            meta.update(metadata)
        out_meta: Optional[Dict[str, Any]] = meta if meta else None

        # Path-A GENY-5/6 — `_maybe_archive_conversation` /
        # `_maybe_archive_dm` are no longer called from here. The
        # executor's `after_record_turn` hook (installed by
        # `AgentSession._install_memory_hooks`) drives both archivers
        # for every STM append, which now includes both the stage 18
        # `_drive_provider` path *and* this synchronous
        # `record_message` (agent-DM tool, internal triggers, etc.)
        # — both call `provider.stm().append`, which fires the hook.
        self._stm_append_message(role, content, out_meta)

    def _maybe_archive_conversation(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]],
    ):
        """Best-effort hand-off to ConversationArchiver.

        Returns the ``ArchivedConversation`` result on success, or
        ``None`` for any reason that means "skip" (legacy metadata,
        archiver not built yet, transient write error). Never raises
        — record_message is a hot path and must not fail because of
        a leaf-archive side-effect.

        See plan §4.2 (record_message hook chain).
        """
        if self._conversation_archiver is None:
            return None
        try:
            return self._conversation_archiver.archive(role, content, metadata)
        except Exception:
            logger.debug(
                "conversation archive hook failed — non-critical",
                exc_info=True,
            )
            return None

    def _maybe_archive_dm(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]],
        conversation_ref: Optional[str],
    ):
        """Best-effort hand-off to DmArchiver. PR 4.

        DmArchiver itself filters by kind / counterpart so this
        wrapper just guards initialisation + exception swallow.
        """
        if self._dm_archiver is None:
            return None
        try:
            return self._dm_archiver.append(
                role, content, metadata, conversation_ref=conversation_ref,
            )
        except Exception:
            logger.debug(
                "dm archive hook failed — non-critical", exc_info=True,
            )
            return None


    def record_event(self, event: str, data: Optional[Dict[str, Any]] = None) -> None:
        """Record a non-message event (tool call, state change, etc.)."""
        self._stm_append_event(event, data)

    def record_compaction(
        self,
        summary: str,
        *,
        replaced_count: int,
        ts: Optional[Any] = None,
        strategy: str = "",
        saved_tokens: Optional[int] = None,
    ) -> Optional[Any]:
        """Persist a compaction snapshot to both the audit log
        (``transcripts/compactions/<ts>.md``) and the vault
        (``memory/compactions/<sid>__<ts>.md``).

        Memory v2 PR 8 — closes plan §2.2 (compaction must survive
        the process so the next session can ``memory_search`` it).

        Best-effort. Returns the ``ArchivedCompaction`` dataclass on
        success, ``None`` on any write failure (logged at debug).
        """
        if self._compaction_archiver is None:
            return None
        try:
            return self._compaction_archiver.archive(
                summary,
                replaced_count=replaced_count,
                ts=ts,
                strategy=strategy,
                saved_tokens=saved_tokens,
            )
        except Exception:
            logger.debug(
                "record_compaction failed — non-critical",
                exc_info=True,
            )
            return None

    def remember(self, text: str, *, heading: Optional[str] = None) -> None:
        """Write durable knowledge to long-term memory.

        This appends to MEMORY.md. For dated entries use remember_dated().

        Args:
            text: The knowledge to persist.
            heading: Optional markdown heading.
        """
        self._ltm_append(text, heading=heading)

    def remember_dated(self, text: str) -> None:
        """Write an execution-summary block to today's executions file.

        Cycle 20260503_5 — the call surface stays the same (every
        existing strategy still calls ``mgr.remember_dated(...)``)
        but the on-disk target changed from
        ``memory/<YYYY-MM-DD>.md`` (which was being shared with
        ``DailyJournalWriter``) to ``memory/executions/<YYYY-MM-DD>.md``
        so the two streams no longer collide on one file.
        """
        self._ltm_write_execution(text)

    def remember_topic(self, topic: str, text: str) -> None:
        """Write knowledge to a topic-specific long-term memory file."""
        self._ltm_write_topic(topic, text)

    # ------------------------------------------------------------------
    # Structured memory operations (Obsidian-like)
    # ------------------------------------------------------------------

    def write_note(
        self,
        title: str,
        content: str,
        *,
        category: str = "topics",
        tags: Optional[List[str]] = None,
        importance: str = "medium",
        source: str = "system",
        links_to: Optional[List[str]] = None,
    ) -> Optional[str]:
        """Write a structured memory note with frontmatter.

        Returns the filename of the created note, or None on failure.
        """
        if self._structured_writer is None:
            # Fallback to legacy write
            self._ltm_write_topic(title, content)
            return None
        return self._structured_writer.write_note(
            title=title,
            content=content,
            category=category,
            tags=tags,
            importance=importance,
            source=source,
            links=links_to,
        )

    def update_note(
        self,
        filename: str,
        *,
        body: Optional[str] = None,
        tags: Optional[List[str]] = None,
        importance: Optional[str] = None,
    ) -> bool:
        """Update an existing structured memory note.

        Returns True if updated successfully.
        """
        if self._structured_writer is None:
            return False
        return self._structured_writer.update_note(
            filename, content=body, tags=tags, importance=importance,
        )

    def delete_note(self, filename: str) -> bool:
        """Delete a structured memory note.

        Returns True if deleted successfully.
        """
        if self._structured_writer is None:
            return False
        return self._structured_writer.delete_note(filename)

    def read_note(self, filename: str) -> Optional[Dict[str, Any]]:
        """Read a structured memory note and return its metadata + body.

        Returns dict with keys: metadata, body, filename. None if not found.
        """
        if self._structured_writer is None:
            return None
        return self._structured_writer.read_note(filename)

    def list_notes(
        self,
        *,
        category: Optional[str] = None,
        tag: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """List memory notes with optional category/tag filters.

        Returns list of note info dicts.
        """
        if self._structured_writer is None:
            return []
        notes = self._structured_writer.list_notes(category=category, tag=tag)
        return [self._file_info_to_dict(n) for n in notes]

    def link_notes(self, source_filename: str, target_filename: str) -> bool:
        """Create a wikilink between two notes.

        Returns True if link was created successfully.
        """
        if self._structured_writer is None:
            return False
        return self._structured_writer.link_notes(source_filename, target_filename)

    def get_memory_index(self) -> Optional[Dict[str, Any]]:
        """Get the full memory index for API responses."""
        if self._memory_provider is None:
            return None
        idx = self._index_snapshot()
        return {
            "files": {k: self._file_info_to_dict(v) for k, v in idx.files.items()},
            "tag_map": idx.tag_map,
            "total_files": idx.total_files,
            "total_chars": idx.total_chars,
        }

    def get_memory_tags(self) -> Dict[str, int]:
        """Get tag counts from the index."""
        if self._memory_provider is None:
            return {}
        idx = self._index_snapshot()
        tag_counts: Dict[str, int] = {}
        for tag, filenames in idx.tag_map.items():
            tag_counts[tag] = len(filenames)
        return tag_counts

    def get_memory_graph(self) -> Dict[str, Any]:
        """Get link graph data for visualization (enhanced with tag edges + metadata)."""
        if self._memory_provider is None:
            return {"nodes": [], "edges": []}
        idx = self._index_snapshot()
        nodes = []
        edges = []
        edge_set: set = set()
        tag_to_files: Dict[str, list] = {}
        files_set = set(idx.files.keys())

        for fn, info in idx.files.items():
            nodes.append({
                "id": fn,
                "label": info.title or fn.replace(".md", ""),
                "category": info.category,
                "importance": info.importance,
                "tags": info.tags,
                "connectionCount": len(info.links_to) + len(info.linked_from),
                "summary": info.summary or "",
                "charCount": info.char_count,
            })

            # Wikilink edges (with target existence filter)
            for target in info.links_to:
                if target in files_set:
                    key = (fn, target)
                    if key not in edge_set:
                        edge_set.add(key)
                        edges.append({
                            "source": fn,
                            "target": target,
                            "type": "wikilink",
                            "weight": 1.0,
                        })

            # Build tag map
            for tag in info.tags:
                tag_to_files.setdefault(tag, []).append(fn)

        # Tag-based edges
        for tag, fns in tag_to_files.items():
            if len(fns) < 2:
                continue
            for i in range(len(fns)):
                for j in range(i + 1, len(fns)):
                    a, b = fns[i], fns[j]
                    if (a, b) not in edge_set and (b, a) not in edge_set:
                        edge_set.add((a, b))
                        edges.append({
                            "source": a,
                            "target": b,
                            "type": "tag",
                            "weight": 0.5,
                            "label": tag,
                        })

        return {"nodes": nodes, "edges": edges}

    def reindex_memory(self) -> int:
        """Force a full rebuild of the memory index.

        Returns total number of indexed files.
        """
        return self._index_rebuild()

    @staticmethod
    def _file_info_to_dict(info) -> Dict[str, Any]:
        """Convert MemoryFileInfo to dict."""
        return {
            "filename": info.filename,
            "title": info.title,
            "category": info.category,
            "tags": info.tags,
            "importance": info.importance,
            "created": info.created,
            "modified": info.modified,
            "source": info.source,
            "char_count": info.char_count,
            "links_to": info.links_to,
            "linked_from": info.linked_from,
            "summary": info.summary,
        }

    async def record_execution(
        self,
        *,
        input_text: str,
        result_state: Dict[str, Any],
        duration_ms: int,
        execution_number: int = 0,
        success: bool = True,
    ) -> None:
        """Record a structured execution summary to long-term memory.

        Called after each graph invoke/astream to persist a concise,
        structured record of work done — modeled after WORK_LOG.md's
        methodology but designed for long-term memory recall.

        Writes to ``memory/YYYY-MM-DD.md`` with structured sections.
        When the vector memory layer is enabled, the entry is also
        indexed into FAISS (awaited to prevent race conditions with
        ``auto_flush`` / ``vmm.save()``).

        File/DB recording is always active regardless of LTM config.
        Only vector indexing (FAISS) requires LTM to be enabled.

        Args:
            input_text: The user's input prompt.
            result_state: The final AutonomousState dict from the graph.
            duration_ms: Total execution wall-time in milliseconds.
            execution_number: Sequential execution counter for this session.
            success: Whether execution completed without errors.
        """
        try:
            entry = self._build_execution_entry(
                input_text=input_text,
                result_state=result_state,
                duration_ms=duration_ms,
                execution_number=execution_number,
                success=success,
            )
            # Cycle 20260503_5 — execution summaries land in
            # ``memory/executions/<YYYY-MM-DD>.md`` instead of the
            # daily-journal root file. The structured-note dual
            # write below still goes to ``memory/daily/`` so the
            # human-friendly card surface keeps working.
            self._ltm_write_execution(entry)
            logger.info(
                "record_execution: #%d (%d chars) → executions/",
                execution_number, len(entry),
            )
            try:
                from service.memory.event_emitter import emit_memory_event

                emit_memory_event(
                    self._session_id,
                    event_type="execution_recorded",
                    source="Memory",
                    layer="ltm",
                    chars=len(entry),
                    extra={
                        "execution_number": execution_number,
                        "success": bool(success),
                    },
                    message=(
                        f"execution_recorded: #{execution_number} "
                        f"({len(entry)} chars, success={success})"
                    ),
                )
            except Exception:  # noqa: BLE001
                logger.debug(
                    "record_execution: memory_event emit skipped",
                    exc_info=True,
                )

            # ── Structured note (dual-write) ─────────────────────────
            if self._structured_writer is not None:
                try:
                    auto_tags = self._extract_execution_tags(
                        input_text, result_state,
                    )
                    status_tag = "success" if success else "failure"
                    all_tags = ["execution", status_tag] + auto_tags
                    imp = "medium" if success else "high"
                    title = (
                        f"Execution #{execution_number} — "
                        f"{input_text[:60].strip()}"
                    )
                    self._structured_writer.write_note(
                        title=title,
                        content=entry,
                        category="daily",
                        tags=all_tags,
                        importance=imp,
                        source="execution",
                    )
                except Exception:
                    logger.debug(
                        "record_execution: structured write failed (non-critical)",
                        exc_info=True,
                    )

            # Index into vector DB (only when LTM config is enabled)
            from service.config.sub_config.general.ltm_config import LTMConfig

            if LTMConfig.is_enabled() and self._vector_enabled:
                try:
                    date_str = datetime.now(_get_tz()).strftime("%Y-%m-%d")
                    source = f"memory/{date_str}.md"
                    await self._vector_index_text(entry, source)
                except Exception:
                    logger.debug(
                        "record_execution: vector indexing failed (non-critical)",
                        exc_info=True,
                    )

        except Exception:
            logger.warning(
                "record_execution: failed to write (non-critical)",
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Execution entry builder
    # ------------------------------------------------------------------

    @staticmethod
    def _build_execution_entry(
        *,
        input_text: str,
        result_state: Dict[str, Any],
        duration_ms: int,
        execution_number: int,
        success: bool,
    ) -> str:
        """Build a structured markdown entry for one graph execution.

        Format:
            ### [✅/❌] Execution #N — <difficulty> path
            > **Task:** <truncated user input>
            > **Duration:** X.Xs | **Iterations:** N/max

            **Result:**
            <truncated final output>

            **TODOs:** (hard path only)
            - ✅ Task title
            - ⬜ Task title

            **Review:** approved/rejected (medium path only)

        Returns:
            Formatted markdown string.
        """
        status_icon = "✅" if success else "❌"

        # --- Extract fields from state ---
        difficulty = result_state.get("difficulty", "unknown")
        iteration = result_state.get("iteration", 0)
        max_iterations = result_state.get("max_iterations", 0)
        error = result_state.get("error")
        completion_signal = result_state.get("completion_signal", "")
        completion_detail = result_state.get("completion_detail", "")

        # Best output: final_answer > answer > last_output
        final_output = (
            result_state.get("final_answer", "")
            or result_state.get("answer", "")
            or result_state.get("last_output", "")
            or ""
        )

        # Truncate for readability
        input_preview = input_text[:_LTM_INPUT_PREVIEW]
        if len(input_text) > _LTM_INPUT_PREVIEW:
            input_preview += "..."

        output_preview = final_output[:_LTM_OUTPUT_PREVIEW]
        if len(final_output) > _LTM_OUTPUT_PREVIEW:
            output_preview += "..."

        # Duration formatting
        if duration_ms >= 60_000:
            duration_str = f"{duration_ms / 60_000:.1f}m"
        elif duration_ms >= 1_000:
            duration_str = f"{duration_ms / 1_000:.1f}s"
        else:
            duration_str = f"{duration_ms}ms"

        # --- Build markdown ---
        lines: list[str] = []

        # Header
        lines.append(
            f"### [{status_icon}] Execution #{execution_number}"
            f" — {difficulty} path"
        )
        lines.append("")

        # Task & metrics
        lines.append(f"> **Task:** {input_preview}")
        lines.append(
            f"> **Duration:** {duration_str}"
            f" | **Iterations:** {iteration}/{max_iterations}"
        )
        lines.append("")

        # TODO list (hard path)
        todos = result_state.get("todos") or []
        if todos and difficulty == "hard":
            lines.append("**TODOs:**")
            for todo in todos:
                title = todo.get("title", "Untitled")
                status = todo.get("status", "pending")
                if status in ("completed",):
                    icon = "✅"
                elif status in ("in_progress",):
                    icon = "🔄"
                elif status in ("failed",):
                    icon = "❌"
                else:
                    icon = "⬜"

                result_text = todo.get("result", "")
                if result_text:
                    result_text = result_text[:_LTM_TODO_RESULT_PREVIEW]
                    if len(todo.get("result", "")) > _LTM_TODO_RESULT_PREVIEW:
                        result_text += "..."
                    lines.append(f"- {icon} **{title}** → {result_text}")
                else:
                    lines.append(f"- {icon} **{title}**")
            lines.append("")

        # Review feedback (medium path)
        review_result = result_state.get("review_result")
        review_feedback = result_state.get("review_feedback")
        if review_result and difficulty == "medium":
            feedback_preview = ""
            if review_feedback:
                feedback_preview = f" — {review_feedback[:200]}"
                if len(review_feedback) > 200:
                    feedback_preview += "..."
            lines.append(f"**Review:** {review_result}{feedback_preview}")
            lines.append("")

        # Completion signal
        if completion_signal and completion_signal not in ("none", "continue"):
            detail = f" ({completion_detail})" if completion_detail else ""
            lines.append(f"**Signal:** {completion_signal}{detail}")
            lines.append("")

        # Error
        if error:
            lines.append(f"**Error:** {error[:300]}")
            lines.append("")

        # Result output
        if output_preview:
            lines.append("**Result:**")
            lines.append(output_preview)
            lines.append("")

        # Fallback info
        fallback = result_state.get("fallback")
        if fallback and fallback.get("degraded"):
            lines.append(
                f"**Model Fallback:** {fallback.get('original_model', '?')}"
                f" → {fallback.get('current_model', '?')}"
                f" (attempts: {fallback.get('attempts', 0)})"
            )
            lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _extract_execution_tags(
        input_text: str,
        result_state: Dict[str, Any],
    ) -> List[str]:
        """Extract auto-tags from execution input and state."""
        tags: List[str] = []
        difficulty = result_state.get("difficulty")
        if difficulty:
            tags.append(difficulty)
        if result_state.get("todos"):
            tags.append("todos")
        if result_state.get("review_result"):
            tags.append("reviewed")
        # Extract simple keyword tags from input
        text = input_text.lower()
        keyword_tags = {
            "debug": "debug",
            "fix": "fix",
            "error": "error",
            "test": "test",
            "deploy": "deploy",
            "build": "build",
            "refactor": "refactor",
            "design": "design",
            "analyze": "analysis",
            "review": "review",
        }
        for keyword, tag in keyword_tags.items():
            if keyword in text and tag not in tags:
                tags.append(tag)
        return tags[:10]  # cap at 10

    # ------------------------------------------------------------------
    # Pinned facts (Memory v2 PR 12 / T1 tier)
    # ------------------------------------------------------------------

    def load_pinned(self, *, max_chars: int = 3000):
        """Return the always-inject pinned-facts surface.

        Reads ``memory/critical/*.md`` via the executor's
        ``NotesHandle.load_pinned`` and packs the bodies (frontmatter
        stripped) into one ``MemoryEntry``. The retriever consumes
        this directly through the new generic ``MemoryAwareRetriever``
        in 1.20.0 — but the host method stays as a sync convenience
        for any in-process caller that still wants the packaged entry.
        """
        return self._ltm_load_pinned(max_chars=max_chars)

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        max_results: int = 10,
        sources: Optional[List[MemorySource]] = None,
    ) -> List[MemorySearchResult]:
        """Search across all memory stores.

        Results from long-term memory are weighted higher (1.2x)
        than short-term memory.

        Args:
            query: Search string.
            max_results: Maximum total results.
            sources: Filter to specific sources. None = all.
        """
        results: list[MemorySearchResult] = []

        if sources is None or MemorySource.LONG_TERM in sources:
            ltm_results = self._ltm_search(query, max_results=max_results)
            for r in ltm_results:
                r.score *= 1.2  # Long-term memory relevance boost
            results.extend(ltm_results)

        if sources is None or MemorySource.SHORT_TERM in sources:
            stm_results = self._stm_search(query, max_results)
            results.extend(stm_results)

        # Sort by combined score, deduplicate if needed
        results.sort(key=lambda r: r.score, reverse=True)
        return results[:max_results]

    async def search_async(
        self,
        query: str,
        *,
        max_results: int = 10,
        sources: Optional[List[MemorySource]] = None,
    ) -> List[MemorySearchResult]:
        """Async sibling of :meth:`search` that also blends vector results.

        Memory v2 PR 12 — restores the vector fallback that was lost
        when ``build_memory_context_async`` was deprecated. The
        agent's ``memory_search`` tool routes here via its async
        path (``MemorySearchTool.arun``) so a Korean query still
        finds an English-titled note via embedding similarity even
        when the keyword-density signal is zero.

        Result merging:
          1. Run :meth:`search` for the keyword + STM portion.
          2. Run :meth:`VectorMemoryManager.search` if enabled.
          3. Wrap vector hits as :class:`MemorySearchResult` carrying
             ``match_type='vector'``.
          4. Deduplicate by filename — keep the highest-scoring entry.
          5. Sort by score desc and slice ``max_results``.
        """
        # 1) Sync keyword path. ``search`` is fast enough to call
        #    inline; running it in a thread would be overkill for
        #    typical session sizes.
        keyword_results = self.search(
            query, max_results=max_results, sources=sources,
        )

        # 2) Vector path — only when the host has wired the layer
        #    AND when the caller did not narrow ``sources`` to
        #    something that excludes long-term memory (vector hits
        #    are by definition LTM-derived).
        vector_results: list[MemorySearchResult] = []
        if sources is None or MemorySource.LONG_TERM in sources:
            if self._vector_enabled:
                try:
                    v_hits = await self._vector_search(query, top_k=max_results)
                except Exception:
                    logger.debug(
                        "search_async: vector search failed", exc_info=True,
                    )
                    v_hits = []
            else:
                v_hits = []
                for vr in v_hits or []:
                    text = getattr(vr, "text", "") or ""
                    if not text.strip():
                        continue
                    source_file = getattr(vr, "source_file", "vector")
                    score = float(getattr(vr, "score", 0.0))
                    entry = MemoryEntry(
                        source=MemorySource.LONG_TERM,
                        content=text,
                        filename=source_file,
                        metadata={
                            "match_type": "vector",
                            "chunk_index": getattr(vr, "chunk_index", 0),
                        },
                    )
                    vector_results.append(
                        MemorySearchResult(
                            entry=entry,
                            score=score,
                            snippet=text[:240],
                            match_type="vector",
                        )
                    )

        # 3) Merge with filename-level dedup. Vector hits boost an
        #    existing keyword hit instead of duplicating it; pure
        #    vector hits land at the bottom of their score band but
        #    still surface when keyword density was zero.
        by_filename: Dict[str, MemorySearchResult] = {}
        for r in keyword_results:
            fn = (r.entry.filename or "") if r.entry else ""
            by_filename[fn or f"_kw_{id(r)}"] = r
        for r in vector_results:
            fn = (r.entry.filename or "") if r.entry else ""
            key = fn or f"_vec_{id(r)}"
            if key in by_filename:
                # Combine: keep the higher-density score, mark
                # ``match_type`` as a hybrid for downstream filters.
                existing = by_filename[key]
                if r.score > existing.score:
                    existing.score = r.score
                existing.match_type = "hybrid"
            else:
                by_filename[key] = r

        merged = list(by_filename.values())
        merged.sort(key=lambda r: r.score, reverse=True)
        return merged[:max_results]

    # ------------------------------------------------------------------
    # Context injection
    # ------------------------------------------------------------------

    def build_memory_context(
        self,
        query: Optional[str] = None,
        *,
        include_summary: bool = True,
        include_recent: int = 0,
        max_chars: Optional[int] = None,
    ) -> Optional[str]:
        """Build a memory context block for system prompt injection.

        .. deprecated:: Memory v2 PR 11
            Path A is retired (plan §5.1). System prompts no longer
            statically inject memory; the s02 ContextStage's
            ``GenyMemoryRetriever`` (slim mode) handles per-turn
            retrieval and the agent's ``memory_*`` tool ladder
            handles deep-dive bodies. Kept here for callers in
            transition; will be removed in a follow-up cycle.

        This was called before each agent turn to inject relevant
        memory into the conversation context.

        Args:
            query: Optional query to search for relevant memories.
            include_summary: Include session summary if available.
            include_recent: Number of recent messages to include (0 = none).
            max_chars: Character budget (default: self._max_inject_chars).

        Returns:
            Formatted memory context string, or None if nothing to inject.
        """
        budget = max_chars or self._max_inject_chars
        parts: list[str] = []
        total_chars = 0

        # 1. Session summary (if available)
        if include_summary:
            summary = self._stm_get_summary()
            if summary and (total_chars + len(summary)) <= budget:
                parts.append(f"<session-summary>\n{summary}\n</session-summary>")
                total_chars += len(summary)

        # 2. Long-term memory: main MEMORY.md
        main_mem = self._ltm_load_main()
        if main_mem and (total_chars + main_mem.char_count) <= budget:
            parts.append(
                f"<long-term-memory source=\"{main_mem.filename}\">\n"
                f"{main_mem.content}\n"
                f"</long-term-memory>"
            )
            total_chars += main_mem.char_count

        # 3. Query-based memory retrieval
        if query:
            search_results = self.search(query, max_results=5)
            for result in search_results:
                chunk = (
                    f"<memory-recall source=\"{result.entry.filename}\" "
                    f"score=\"{result.score:.2f}\">\n"
                    f"{result.snippet}\n"
                    f"</memory-recall>"
                )
                if (total_chars + len(chunk)) > budget:
                    break
                parts.append(chunk)
                total_chars += len(chunk)

        # 4. Recent transcript messages
        if include_recent > 0:
            recent = self._stm_get_recent(include_recent)
            for entry in recent:
                if (total_chars + entry.char_count) > budget:
                    break
                parts.append(
                    f"<recent-message>\n{entry.content}\n</recent-message>"
                )
                total_chars += entry.char_count

        if not parts:
            return None

        header = "## Recalled Memory\n"
        body = "\n\n".join(parts)
        return f"{header}\n{body}"

    async def build_memory_context_async(
        self,
        query: Optional[str] = None,
        *,
        include_summary: bool = True,
        include_recent: int = 0,
        max_chars: Optional[int] = None,
    ) -> Optional[str]:
        """Async version of ``build_memory_context`` with vector search.

        .. deprecated:: Memory v2 PR 11
            Same rationale as :meth:`build_memory_context` —
            production never wired this method (review.md P10) and
            v2 routes retrieval through ``GenyMemoryRetriever``
            instead.

        Includes FAISS vector search results when the vector memory
        layer is enabled, in addition to keyword search and file-based
        retrieval.

        Args:
            query: Optional query to search for relevant memories.
            include_summary: Include session summary if available.
            include_recent: Number of recent messages to include.
            max_chars: Character budget.

        Returns:
            Formatted memory context string, or None.
        """
        budget = max_chars or self._max_inject_chars
        parts: list[str] = []
        total_chars = 0

        # 1. Session summary
        if include_summary:
            summary = self._stm_get_summary()
            if summary and (total_chars + len(summary)) <= budget:
                parts.append(f"<session-summary>\n{summary}\n</session-summary>")
                total_chars += len(summary)

        # 2. Main MEMORY.md
        main_mem = self._ltm_load_main()
        if main_mem and (total_chars + main_mem.char_count) <= budget:
            parts.append(
                f"<long-term-memory source=\"{main_mem.filename}\">\n"
                f"{main_mem.content}\n"
                f"</long-term-memory>"
            )
            total_chars += main_mem.char_count

        # 3. Vector semantic search (if enabled)
        if query and self._vector_enabled:
            try:
                v_results = await self._vector_search(query)
                v_context = self._vector_build_context(
                    v_results, max_chars=budget - total_chars
                )
                if v_context:
                    parts.append(v_context)
                    total_chars += len(v_context)
            except Exception:
                logger.debug(
                    "build_memory_context_async: vector search failed",
                    exc_info=True,
                )

        # 4. Keyword-based memory recall (complementary)
        if query:
            remaining_budget = budget - total_chars
            if remaining_budget > 200:
                search_results = self.search(query, max_results=5)
                for result in search_results:
                    chunk = (
                        f"<memory-recall source=\"{result.entry.filename}\" "
                        f"score=\"{result.score:.2f}\">\n"
                        f"{result.snippet}\n"
                        f"</memory-recall>"
                    )
                    if (total_chars + len(chunk)) > budget:
                        break
                    parts.append(chunk)
                    total_chars += len(chunk)

        # 5. Recent transcript messages
        if include_recent > 0:
            recent = self._stm_get_recent(include_recent)
            for entry in recent:
                if (total_chars + entry.char_count) > budget:
                    break
                parts.append(
                    f"<recent-message>\n{entry.content}\n</recent-message>"
                )
                total_chars += entry.char_count

        if not parts:
            return None

        header = "## Recalled Memory\n"
        body = "\n\n".join(parts)
        return f"{header}\n{body}"

    # ------------------------------------------------------------------
    # Memory flush (pre-compaction)
    # ------------------------------------------------------------------

    def flush_to_long_term(
        self,
        content: str,
        *,
        heading: str = "Session Memory Flush",
    ) -> None:
        """Flush important information from short-term to long-term memory.

        Called before context compaction to preserve durable facts.

        Args:
            content: Text to persist.
            heading: Section heading in MEMORY.md.
        """
        self._ltm_append(content, heading=heading)
        logger.info(
            "Memory flush: %d chars saved to long-term memory", len(content)
        )

    def auto_flush(self, recent_n: int = 30) -> Optional[str]:
        """Generate a structured session-end summary for long-term storage.

        Called during session cleanup. Instead of dumping raw transcript,
        produces a concise session summary with conversation statistics
        that is useful for future memory recall.

        Skipped entirely when LTM is disabled in config.

        Args:
            recent_n: Number of recent messages to include excerpts from.

        Returns:
            The flushed text, or None if nothing to flush.
        """
        # Guard: skip when long-term memory is disabled in config
        from service.config.sub_config.general.ltm_config import LTMConfig

        if not LTMConfig.is_enabled():
            logger.debug("auto_flush: LTM disabled by config — skipping")
            return None

        now = datetime.now(_get_tz())
        all_entries = self._stm_load_all()
        if not all_entries:
            return None

        # --- Gather statistics ---
        user_msgs = [e for e in all_entries if "[user]" in e.content.lower()]
        assistant_msgs = [e for e in all_entries if "[assistant]" in e.content.lower()]
        total_chars = sum(e.char_count for e in all_entries)

        # First and last timestamps
        timestamps = [e.timestamp for e in all_entries if e.timestamp]
        first_ts = min(timestamps) if timestamps else None
        last_ts = max(timestamps) if timestamps else None

        duration_str = ""
        if first_ts and last_ts:
            delta = last_ts - first_ts
            total_minutes = int(delta.total_seconds() / 60)
            if total_minutes >= 60:
                duration_str = f"{total_minutes // 60}h {total_minutes % 60}m"
            else:
                duration_str = f"{total_minutes}m"

        # --- Build summary ---
        lines: list[str] = []
        lines.append("### 📋 Session End Summary")
        lines.append("")

        metrics = [f"**Messages:** {len(all_entries)} total"]
        metrics.append(
            f"({len(user_msgs)} user, {len(assistant_msgs)} assistant)"
        )
        if duration_str:
            metrics.append(f"| **Duration:** {duration_str}")
        metrics.append(f"| **Total chars:** {total_chars:,}")
        lines.append(" ".join(metrics))
        lines.append("")

        # Conversation flow: list user requests as bullet points
        if user_msgs:
            lines.append("**Conversation Flow:**")
            for i, entry in enumerate(user_msgs, 1):
                # Extract just the content (strip [user] prefix)
                content = entry.content
                if content.lower().startswith("[user] "):
                    content = content[7:]
                preview = content[:150]
                if len(content) > 150:
                    preview += "..."
                ts_str = ""
                if entry.timestamp:
                    ts_str = f"[{entry.timestamp.strftime('%H:%M')}] "
                lines.append(f"{i}. {ts_str}{preview}")

                # Limit to 20 entries for readability
                if i >= 20:
                    remaining = len(user_msgs) - 20
                    if remaining > 0:
                        lines.append(f"   ... +{remaining} more requests")
                    break
            lines.append("")

        summary_text = "\n".join(lines)

        if len(summary_text) < 50:
            return None  # Too short to bother

        # Save to today's executions file (was the daily-journal
        # root file pre-cycle-20260503_5 — same content shape, new
        # location to keep daily-journal index pure).
        self._ltm_write_execution(summary_text)

        # Persist session summary for future context injection on restore
        self._stm_write_summary(summary_text)

        # Vector store flushes on every write (executor file backend);
        # nothing extra to do here on auto_flush.

        logger.info(
            "auto_flush: session summary (%d chars, %d messages) → long-term",
            len(summary_text), len(all_entries),
        )
        return summary_text

    # ------------------------------------------------------------------
    # Statistics
    # ------------------------------------------------------------------

    def get_stats(self) -> MemoryStats:
        """Compute memory statistics.

        Uses DB aggregation when available for efficiency;
        falls back to loading all entries from file.
        """
        # Try lightweight DB aggregation first
        if self._db_manager is not None and self._session_id is not None:
            try:
                from service.database.memory_db_helper import db_memory_stats

                db_stats = db_memory_stats(self._db_manager, self._session_id)
                if db_stats is not None:
                    last_write = None
                    ts_str = db_stats.get("last_write")
                    if ts_str:
                        try:
                            last_write = datetime.fromisoformat(ts_str)
                        except (ValueError, TypeError):
                            pass

                    # Add structured stats from index
                    categories: Dict[str, int] = {}
                    total_tags = 0
                    total_links = 0
                    if self._memory_provider is not None:
                        idx = self._index_snapshot()
                        for info in idx.files.values():
                            cat = info.category or "root"
                            categories[cat] = categories.get(cat, 0) + 1
                        total_tags = len(idx.tag_map)
                        total_links = sum(
                            len(info.links_to) for info in idx.files.values()
                        )

                    return MemoryStats(
                        long_term_entries=db_stats.get("long_term_entries", 0),
                        short_term_entries=db_stats.get("short_term_entries", 0),
                        long_term_chars=db_stats.get("long_term_chars", 0),
                        short_term_chars=db_stats.get("short_term_chars", 0),
                        total_files=db_stats.get("total_files", 0),
                        last_write=last_write,
                        categories=categories,
                        total_tags=total_tags,
                        total_links=total_links,
                    )
            except Exception:
                pass

        # Fallback: load all entries from file system
        ltm_entries = self._ltm_load_all()
        stm_entries = self._stm_load_all()

        ltm_chars = sum(e.char_count for e in ltm_entries)
        stm_chars = sum(e.char_count for e in stm_entries)

        all_timestamps = [
            e.timestamp for e in ltm_entries + stm_entries
            if e.timestamp is not None
        ]
        last_write = max(all_timestamps) if all_timestamps else None

        # Structured stats from index
        categories: Dict[str, int] = {}
        total_tags = 0
        total_links = 0
        if self._memory_provider is not None:
            idx = self._index_snapshot()
            for info in idx.files.values():
                cat = info.category or "root"
                categories[cat] = categories.get(cat, 0) + 1
            total_tags = len(idx.tag_map)
            total_links = sum(len(info.links_to) for info in idx.files.values())

        return MemoryStats(
            long_term_entries=len(ltm_entries),
            short_term_entries=len(stm_entries),
            long_term_chars=ltm_chars,
            short_term_chars=stm_chars,
            total_files=len(ltm_entries),
            last_write=last_write,
            categories=categories,
            total_tags=total_tags,
            total_links=total_links,
        )


# ─────────────────────────────────────────────────────────────────
# Module-level helpers
# ─────────────────────────────────────────────────────────────────


