"""
Curated Knowledge Tools — Built-in tools for agent access to curated knowledge.

These tools allow agents to search, read, and list curated knowledge notes
that have been quality-filtered from User Opsidian. They also provide
optional read access to User Opsidian notes (controlled by LTMConfig).

Tool categories:
  - Read: search, read, list curated knowledge notes
  - Opsidian: browse and read User Opsidian notes (gated by config)
  - Promote: promote session notes to curated knowledge

These tools are auto-loaded by ToolLoader (matches *_tools.py pattern).
"""

from __future__ import annotations

import asyncio
import json
from logging import getLogger
from typing import Any, Awaitable, Dict, List, Optional, TypeVar

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool

logger = getLogger(__name__)


_T = TypeVar("_T")


def _log_knowledge_event(
    session_id: str,
    *,
    event_type: str,
    source: str,
    message: str,
    engine: Optional[str] = None,
    hits: Optional[int] = None,
    top_score: Optional[float] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Drop a `MEMORY` log row that the chat broadcast forwards to the
    frontend's VTuber LOGS panel.

    Best-effort — a logger import failure or a missing session logger
    must not fail the tool call.
    """
    try:
        from service.logging.session_logger import get_session_logger

        slog = get_session_logger(session_id, create_if_missing=False)
        if slog is None:
            return
        slog.log_memory_event(
            event_type=event_type,
            message=message,
            source=source,
            engine=engine,
            score=top_score,
            extra={"hits": hits, **(extra or {})} if hits is not None else extra,
        )
    except Exception:  # noqa: BLE001
        logger.debug("knowledge_search: memory_event log skipped", exc_info=True)


def _run_async_in_sync_call(coro: Awaitable[_T]) -> _T:
    """Run an awaitable from a sync context.

    `BaseTool.run` is sync, but the executor's `VectorHandle.search`
    is async. Use the running loop when one exists (FastAPI request
    handler running in a thread pool sees the worker loop) and fall
    back to a fresh `asyncio.run` for direct CLI / test invocations.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)  # type: ignore[arg-type]
    # In a running loop — schedule on a fresh helper loop in a thread
    # so we don't reenter. Keeps the behaviour identical for both
    # request and CLI contexts.
    import concurrent.futures

    def _runner() -> _T:
        new_loop = asyncio.new_event_loop()
        try:
            return new_loop.run_until_complete(coro)  # type: ignore[arg-type]
        finally:
            new_loop.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(_runner).result()


# Read-only knowledge / Opsidian browse defaults — every search/read/list
# is idempotent and safe to fan out. Only KnowledgePromote mutates.
_READ_ONLY_KNOWLEDGE = ToolCapabilities(
    concurrency_safe=True, read_only=True, idempotent=True,
)


# ============================================================================
# Helpers
# ============================================================================

def _get_agent_manager():
    from service.executor import get_agent_session_manager
    return get_agent_session_manager()


def _get_context_managers(session_id: str):
    """Get curated_knowledge_manager and user_opsidian_manager from an agent session.

    Returns (curated_mgr, opsidian_mgr) tuple. Either may be None.
    """
    manager = _get_agent_manager()
    agent = manager.get_agent(session_id)
    if agent is None:
        agent = manager.resolve_session(session_id)
    if agent is None:
        return None, None

    # Try to get from the agent's graph context
    curated = getattr(agent, "_curated_knowledge_manager", None)
    opsidian = getattr(agent, "_user_opsidian_manager", None)

    # Fallback: try from the owner_username
    if curated is None or opsidian is None:
        username = getattr(agent, "_owner_username", None) or getattr(agent, "owner_username", None)
        if username:
            if curated is None:
                try:
                    from service.memory.curated_knowledge import get_curated_knowledge_manager
                    curated = get_curated_knowledge_manager(username)
                except Exception:
                    pass
            if opsidian is None:
                try:
                    from service.memory.user_opsidian import get_user_opsidian_manager
                    opsidian = get_user_opsidian_manager(username)
                except Exception:
                    pass

    return curated, opsidian


def _get_ltm_config():
    """Load LTMConfig for feature gating."""
    try:
        from service.config import get_config_manager
        from service.config.sub_config.general.ltm_config import LTMConfig
        mgr = get_config_manager()
        return mgr.load_config(LTMConfig)
    except Exception:
        return None


def _error(msg: str) -> str:
    return json.dumps({"error": msg}, ensure_ascii=False)


def _ok(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


# ── ViewLedger decoration (whiteboard P2a) ───────────────────────────


def _maybe_decorate_results(
    session_id: str,
    *,
    items: List[Dict[str, Any]],
    event: str,
    field: str = "filename",
) -> List[Dict[str, Any]]:
    """Annotate each item with ``_view`` and record one event per item.

    Best-effort: any failure inside the ledger path is logged at debug
    and the items are returned untouched. The agent's hot path must
    never be broken by a missing ViewLedger.
    """
    try:
        from service.whiteboard.agent_resolver import resolve_user_and_agent
        from service.whiteboard.view_ledger import get_view_ledger
    except Exception:  # noqa: BLE001
        return items
    try:
        username, agent_id = resolve_user_and_agent(session_id)
    except Exception:  # noqa: BLE001
        return items
    if not username or not agent_id:
        return items
    try:
        ledger = get_view_ledger(username, agent_id)
        ledger.decorate(items, field=field)
        for item in items:
            note_id = item.get(field)
            if note_id:
                ledger.record(str(note_id), event, context=f"session:{session_id}")
    except Exception:  # noqa: BLE001
        logger.debug("ViewLedger decoration failed", exc_info=True)
    return items


def _maybe_decorate_single(
    session_id: str,
    *,
    item: Dict[str, Any],
    event: str,
    field: str = "filename",
) -> Dict[str, Any]:
    """Decorate a single dict (used by `knowledge_read`)."""
    try:
        from service.whiteboard.agent_resolver import resolve_user_and_agent
        from service.whiteboard.view_ledger import get_view_ledger
    except Exception:  # noqa: BLE001
        return item
    try:
        username, agent_id = resolve_user_and_agent(session_id)
    except Exception:  # noqa: BLE001
        return item
    if not username or not agent_id:
        return item
    try:
        ledger = get_view_ledger(username, agent_id)
        note_id = item.get(field)
        if note_id:
            item["_view"] = ledger.view_meta(str(note_id))
            ledger.record(str(note_id), event, context=f"session:{session_id}")
    except Exception:  # noqa: BLE001
        logger.debug("ViewLedger decoration (single) failed", exc_info=True)
    return item


# ============================================================================
# Knowledge Search Tool
# ============================================================================

class KnowledgeSearchTool(BaseTool):
    """Search across curated knowledge notes using keyword matching."""

    name = "knowledge_search"
    description = (
        "Search through your curated knowledge base for relevant notes. "
        "These are quality-verified notes that have been refined from the "
        "user's personal knowledge vault. Returns the most relevant results."
    )
    CAPABILITIES = _READ_ONLY_KNOWLEDGE

    def run(
        self,
        session_id: str,
        query: str,
        max_results: int = 5,
    ) -> str:
        """Search curated knowledge notes.

        Hybrid search: when the executor's `MemoryProvider` is wired
        on the session AND the curated handle exposes a vector layer,
        the tool runs a semantic search first. Empty / missing vector
        layer falls back to the legacy keyword search inside
        `CuratedKnowledgeManager.search`. This makes the FAISS-backed
        retrieval path the default once a host enables the embedding
        provider in LTMConfig — no per-tool flag flip required.

        Args:
            session_id: Your session ID.
            query: Search query — keyword, phrase, or question.
            max_results: Maximum results to return (default: 5).
        """
        config = _get_ltm_config()
        if config is None or not config.curated_knowledge_enabled:
            return _error("Curated knowledge is not enabled")

        curated, _ = _get_context_managers(session_id)
        if curated is None:
            return _error("Curated knowledge manager not available")

        # Prefer the executor MemoryProvider's curated handle when the
        # agent session has one wired. The handle owns both the
        # markdown notes and (when an embedding client is present) the
        # vector layer; auto-vector indexing on note write keeps the
        # two in lockstep.
        provider_results = self._search_via_provider(
            session_id, query, max_results
        )
        if provider_results is not None:
            _log_knowledge_event(
                session_id,
                event_type="knowledge_search",
                source="Knowledge",
                engine="executor.memory_provider",
                message=(
                    f"knowledge_search: '{query[:60]}' → {len(provider_results)} hits "
                    f"via executor.memory_provider"
                ),
                hits=len(provider_results),
                top_score=(
                    provider_results[0]["score"] if provider_results else None
                ),
            )
            _maybe_decorate_results(
                session_id, items=provider_results, event="searched"
            )
            return _ok({
                "query": query,
                "total": len(provider_results),
                "results": provider_results,
                "engine": "executor.memory_provider",
            })

        # Legacy keyword path — still useful when the provider is
        # disabled or the user has no curated vault yet.
        results = curated.search(query, max_results=max_results)
        items = []
        for r in results:
            items.append({
                "filename": r.get("filename"),
                "title": r.get("title"),
                "category": r.get("category"),
                "tags": r.get("tags"),
                "importance": r.get("importance"),
                "score": round(r.get("score", 0), 4),
                "snippet": r.get("snippet", "")[:500],
            })
        _log_knowledge_event(
            session_id,
            event_type="knowledge_search",
            source="Knowledge",
            engine="legacy.keyword",
            message=(
                f"knowledge_search: '{query[:60]}' → {len(items)} hits "
                f"via legacy.keyword"
            ),
            hits=len(items),
            top_score=items[0]["score"] if items else None,
        )
        _maybe_decorate_results(session_id, items=items, event="searched")
        return _ok({
            "query": query,
            "total": len(items),
            "results": items,
            "engine": "legacy.keyword",
        })

    @staticmethod
    def _search_via_provider(
        session_id: str, query: str, max_results: int
    ) -> Optional[List[Dict[str, Any]]]:
        """Run vector search through the executor MemoryProvider.

        Returns ``None`` to mean "not available, fall back to legacy".
        Returns ``[]`` for "available but no hits" — that distinction
        lets the caller decide whether to retry on the keyword path.
        """
        from service.executor.agent_session_manager import agent_manager

        agent = agent_manager.get_agent(session_id)
        provider = getattr(agent, "memory_provider", None) if agent else None
        if provider is None:
            return None
        curated_handle = provider.curated()
        if curated_handle is None:
            return None
        vector = curated_handle.vector()
        if vector is None:
            return None

        # `_run_async_in_sync_call` mirrors the helper this module
        # already uses for other async-from-sync hops.
        try:
            chunks = _run_async_in_sync_call(
                vector.search(query, top_k=max_results)
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "knowledge_search: vector search failed; falling back to keyword",
                exc_info=True,
            )
            return None

        return [
            {
                "filename": c.key,
                "title": (c.metadata or {}).get("title", c.key),
                "category": (c.metadata or {}).get("category"),
                "tags": (c.metadata or {}).get("tags", []),
                "importance": (c.metadata or {}).get("importance"),
                "score": round(c.relevance_score, 4),
                "snippet": (c.content or "")[:500],
            }
            for c in chunks
        ]


# ============================================================================
# Knowledge Read Tool
# ============================================================================

class KnowledgeReadTool(BaseTool):
    """Read a specific curated knowledge note by filename."""

    name = "knowledge_read"
    description = (
        "Read a specific curated knowledge note by its filename. "
        "Returns the full content including metadata and body text."
    )
    CAPABILITIES = _READ_ONLY_KNOWLEDGE

    def run(self, session_id: str, filename: str) -> str:
        """Read a curated knowledge note.

        Args:
            session_id: Your session ID.
            filename: The filename of the curated note to read.
        """
        config = _get_ltm_config()
        if config is None or not config.curated_knowledge_enabled:
            return _error("Curated knowledge is not enabled")

        curated, _ = _get_context_managers(session_id)
        if curated is None:
            return _error("Curated knowledge manager not available")

        note = curated.read_note(filename)
        if note is None:
            _log_knowledge_event(
                session_id,
                event_type="knowledge_read_miss",
                source="Knowledge",
                message=f"knowledge_read miss: {filename}",
            )
            return _error(f"Note not found: {filename}")
        body_chars = len((note.get("body") or ""))
        _log_knowledge_event(
            session_id,
            event_type="knowledge_read",
            source="Knowledge",
            message=f"knowledge_read: {filename} ({body_chars} chars)",
            extra={"chars": body_chars, "filename": filename},
        )
        # Ensure the note dict has a ``filename`` key for the ledger
        # decoration; some read paths only return body+metadata.
        note.setdefault("filename", filename)
        _maybe_decorate_single(session_id, item=note, event="read")
        return _ok(note)

    async def arun(self, session_id: str, filename: str) -> str:
        config = _get_ltm_config()
        if config is None or not config.curated_knowledge_enabled:
            return _error("Curated knowledge is not enabled")
        curated, _ = _get_context_managers(session_id)
        if curated is None:
            return _error("Curated knowledge manager not available")
        aread = getattr(curated, "aread_note", None)
        note = await aread(filename) if callable(aread) else curated.read_note(filename)
        if note is None:
            _log_knowledge_event(
                session_id,
                event_type="knowledge_read_miss",
                source="Knowledge",
                message=f"knowledge_read miss: {filename}",
            )
            return _error(f"Note not found: {filename}")
        body_chars = len((note.get("body") or ""))
        _log_knowledge_event(
            session_id,
            event_type="knowledge_read",
            source="Knowledge",
            message=f"knowledge_read: {filename} ({body_chars} chars)",
            extra={"chars": body_chars, "filename": filename},
        )
        # Ensure the note dict has a ``filename`` key for the ledger
        # decoration; some read paths only return body+metadata.
        note.setdefault("filename", filename)
        _maybe_decorate_single(session_id, item=note, event="read")
        return _ok(note)


# ============================================================================
# Knowledge List Tool
# ============================================================================

class KnowledgeListTool(BaseTool):
    """List curated knowledge notes with optional filtering."""

    name = "knowledge_list"
    description = (
        "List curated knowledge notes. You can filter by category or tag. "
        "Useful for browsing the user's verified knowledge base."
    )
    CAPABILITIES = _READ_ONLY_KNOWLEDGE

    def run(
        self,
        session_id: str,
        category: str = "",
        tag: str = "",
    ) -> str:
        """List curated knowledge notes.

        Args:
            session_id: Your session ID.
            category: Filter by category (leave empty for all).
            tag: Filter by tag (leave empty for all).
        """
        config = _get_ltm_config()
        if config is None or not config.curated_knowledge_enabled:
            return _error("Curated knowledge is not enabled")

        curated, _ = _get_context_managers(session_id)
        if curated is None:
            return _error("Curated knowledge manager not available")

        kwargs = {}
        if category:
            kwargs["category"] = category
        if tag:
            kwargs["tag"] = tag

        notes = curated.list_notes(**kwargs)
        filter_label = (
            f"category={category}" if category else f"tag={tag}" if tag else "all"
        )
        _log_knowledge_event(
            session_id,
            event_type="knowledge_list",
            source="Knowledge",
            message=f"knowledge_list ({filter_label}): {len(notes)} note(s)",
            extra={
                "category": category or None,
                "tag": tag or None,
                "count": len(notes),
            },
        )
        _maybe_decorate_results(session_id, items=list(notes), event="listed")
        return _ok({
            "total": len(notes),
            "filters": {"category": category or None, "tag": tag or None},
            "notes": notes,
        })

    async def arun(
        self,
        session_id: str,
        category: str = "",
        tag: str = "",
    ) -> str:
        config = _get_ltm_config()
        if config is None or not config.curated_knowledge_enabled:
            return _error("Curated knowledge is not enabled")
        curated, _ = _get_context_managers(session_id)
        if curated is None:
            return _error("Curated knowledge manager not available")
        kwargs: Dict[str, Any] = {}
        if category:
            kwargs["category"] = category
        if tag:
            kwargs["tag"] = tag
        alist = getattr(curated, "alist_notes", None)
        notes = (
            await alist(**kwargs) if callable(alist)
            else curated.list_notes(**kwargs)
        )
        filter_label = (
            f"category={category}" if category else f"tag={tag}" if tag else "all"
        )
        _log_knowledge_event(
            session_id,
            event_type="knowledge_list",
            source="Knowledge",
            message=f"knowledge_list ({filter_label}): {len(notes)} note(s)",
            extra={
                "category": category or None,
                "tag": tag or None,
                "count": len(notes),
            },
        )
        _maybe_decorate_results(session_id, items=list(notes), event="listed")
        return _ok({
            "total": len(notes),
            "filters": {"category": category or None, "tag": tag or None},
            "notes": notes,
        })


# ============================================================================
# Knowledge Promote Tool — promote session note to curated knowledge
# ============================================================================

class KnowledgePromoteTool(BaseTool):
    """Promote a session memory note to curated knowledge."""

    name = "knowledge_promote"
    description = (
        "Promote an important session memory note to the user's curated "
        "knowledge base. This makes the knowledge persistent across sessions "
        "and accessible to future agents."
    )
    # Cross-store mutation — must serialize.
    CAPABILITIES = ToolCapabilities(concurrency_safe=False)

    def run(self, session_id: str, filename: str) -> str:
        """Promote a session note to curated knowledge.

        Args:
            session_id: Your session ID.
            filename: The session memory note filename to promote.
        """
        config = _get_ltm_config()
        if config is None or not config.curated_knowledge_enabled:
            return _error("Curated knowledge is not enabled")

        curated, _ = _get_context_managers(session_id)
        if curated is None:
            return _error("Curated knowledge manager not available")

        # Get session memory manager
        agent_mgr = _get_agent_manager()
        agent = agent_mgr.get_agent(session_id)
        if agent is None:
            agent = agent_mgr.resolve_session(session_id)
        if agent is None:
            return _error(f"Session not found: {session_id}")

        mem = getattr(agent, "memory_manager", None)
        if mem is None:
            return _error("Session memory manager not available")

        curated_fn = curated.promote_from_session(
            mem, filename, session_id=session_id,
        )
        if curated_fn:
            return _ok({
                "status": "promoted",
                "source_filename": filename,
                "curated_filename": curated_fn,
            })
        return _error(f"Failed to promote note: {filename}")

    async def arun(self, session_id: str, filename: str) -> str:
        config = _get_ltm_config()
        if config is None or not config.curated_knowledge_enabled:
            return _error("Curated knowledge is not enabled")
        curated, _ = _get_context_managers(session_id)
        if curated is None:
            return _error("Curated knowledge manager not available")
        agent_mgr = _get_agent_manager()
        agent = agent_mgr.get_agent(session_id)
        if agent is None:
            agent = agent_mgr.resolve_session(session_id)
        if agent is None:
            return _error(f"Session not found: {session_id}")
        mem = getattr(agent, "memory_manager", None)
        if mem is None:
            return _error("Session memory manager not available")
        apromote = getattr(curated, "apromote_from_session", None)
        curated_fn = (
            await apromote(mem, filename, session_id=session_id) if callable(apromote)
            else curated.promote_from_session(mem, filename, session_id=session_id)
        )
        if curated_fn:
            return _ok({
                "status": "promoted",
                "source_filename": filename,
                "curated_filename": curated_fn,
            })
        return _error(f"Failed to promote note: {filename}")


# ============================================================================
# Opsidian Browse Tool — browse user's personal vault index
# ============================================================================

class OpsidianBrowseTool(BaseTool):
    """Browse the user's personal Opsidian knowledge vault index."""

    name = "opsidian_browse"
    description = (
        "Browse the user's personal Opsidian knowledge vault. "
        "Lists available notes with titles, categories, and tags. "
        "Use this to discover what knowledge the user has."
    )
    CAPABILITIES = _READ_ONLY_KNOWLEDGE

    def run(
        self,
        session_id: str,
        category: str = "",
        tag: str = "",
    ) -> str:
        """Browse User Opsidian notes.

        Args:
            session_id: Your session ID.
            category: Filter by category (leave empty for all).
            tag: Filter by tag (leave empty for all).
        """
        config = _get_ltm_config()
        if config is None or not config.user_opsidian_index_enabled:
            return _error("User Opsidian index access is not enabled")

        _, opsidian = _get_context_managers(session_id)
        if opsidian is None:
            return _error("User Opsidian manager not available")

        kwargs = {}
        if category:
            kwargs["category"] = category
        if tag:
            kwargs["tag"] = tag

        notes = opsidian.list_notes(**kwargs)
        return _ok({
            "total": len(notes),
            "filters": {"category": category or None, "tag": tag or None},
            "notes": notes,
        })

    async def arun(
        self,
        session_id: str,
        category: str = "",
        tag: str = "",
    ) -> str:
        config = _get_ltm_config()
        if config is None or not config.user_opsidian_index_enabled:
            return _error("User Opsidian index access is not enabled")
        _, opsidian = _get_context_managers(session_id)
        if opsidian is None:
            return _error("User Opsidian manager not available")
        kwargs: Dict[str, Any] = {}
        if category:
            kwargs["category"] = category
        if tag:
            kwargs["tag"] = tag
        alist = getattr(opsidian, "alist_notes", None)
        notes = (
            await alist(**kwargs) if callable(alist)
            else opsidian.list_notes(**kwargs)
        )
        return _ok({
            "total": len(notes),
            "filters": {"category": category or None, "tag": tag or None},
            "notes": notes,
        })


# ============================================================================
# Opsidian Read Tool — read a specific user note
# ============================================================================

class OpsidianReadTool(BaseTool):
    """Read a specific note from the user's personal Opsidian vault."""

    name = "opsidian_read"
    description = (
        "Read a specific note from the user's personal Opsidian vault. "
        "This gives you access to the user's raw personal knowledge. "
        "Use opsidian_browse first to find the filename."
    )
    CAPABILITIES = _READ_ONLY_KNOWLEDGE

    def run(self, session_id: str, filename: str) -> str:
        """Read a User Opsidian note.

        Args:
            session_id: Your session ID.
            filename: The filename of the note to read.
        """
        config = _get_ltm_config()
        if config is None or not config.user_opsidian_raw_read_enabled:
            return _error("User Opsidian raw read access is not enabled")

        _, opsidian = _get_context_managers(session_id)
        if opsidian is None:
            return _error("User Opsidian manager not available")

        note = opsidian.read_note(filename)
        if note is None:
            return _error(f"Note not found: {filename}")
        return _ok(note)

    async def arun(self, session_id: str, filename: str) -> str:
        config = _get_ltm_config()
        if config is None or not config.user_opsidian_raw_read_enabled:
            return _error("User Opsidian raw read access is not enabled")
        _, opsidian = _get_context_managers(session_id)
        if opsidian is None:
            return _error("User Opsidian manager not available")
        aread = getattr(opsidian, "aread_note", None)
        note = (
            await aread(filename) if callable(aread)
            else opsidian.read_note(filename)
        )
        if note is None:
            return _error(f"Note not found: {filename}")
        return _ok(note)


# ============================================================================
# Opsidian Search Tool — keyword search of the user's vault
# ============================================================================


class OpsidianSearchTool(BaseTool):
    """Keyword-search the user's personal Opsidian vault.

    Filling the gap between ``opsidian_browse`` (lists every note,
    no scoring) and ``opsidian_read`` (needs an exact filename).
    The agent rarely knows the filename, so without a search tool
    every "look at my notes about X" turn devolved into a list +
    repeated read loop. ``UserOpsidianManager.search`` already
    implements the keyword scoring (title 2x, body 1x, tag 0.5x),
    we just expose it.

    Performance guard: ``UserOpsidianManager.search`` does an N+1
    read (list every note, fetch every body) so we cap the vault
    size per call via ``GENY_WHITEBOARD_OPSIDIAN_SEARCH_MAX_NOTES``
    (default 500). Above the cap we return an empty result + a
    ``warning`` field steering the agent to ``opsidian_browse``
    with a category/tag filter instead of a free-text search.
    """

    name = "opsidian_search"
    description = (
        "Search the user's personal Opsidian vault by keyword. "
        "Returns the most relevant notes with title, category, "
        "tags, score, and a short snippet. Use this BEFORE "
        "opsidian_read when you don't already know the filename. "
        "For very large vaults (>500 notes) the response includes "
        "a warning telling you to fall back to opsidian_browse "
        "with a category or tag filter."
    )
    CAPABILITIES = _READ_ONLY_KNOWLEDGE

    def run(
        self,
        session_id: str,
        query: str,
        max_results: int = 5,
    ) -> str:
        """Keyword-search User Opsidian.

        Args:
            session_id: Your session ID.
            query: Search query — keyword, phrase, or question.
            max_results: Maximum results to return (default: 5).
        """
        config = _get_ltm_config()
        if config is None or not config.user_opsidian_index_enabled:
            return _error("User Opsidian index access is not enabled")
        _, opsidian = _get_context_managers(session_id)
        if opsidian is None:
            return _error("User Opsidian manager not available")
        if not query or not query.strip():
            return _error("query is required")

        warning = self._size_guard(opsidian)
        if warning is not None:
            return _ok({
                "query": query, "total": 0, "results": [],
                "engine": "opsidian.keyword", "warning": warning,
            })

        results = opsidian.search(query, max_results=max_results)
        items = [
            {
                "filename": r.get("filename"),
                "title": r.get("title"),
                "category": r.get("category"),
                "tags": r.get("tags"),
                "importance": r.get("importance"),
                "score": round(float(r.get("score", 0) or 0), 4),
                "snippet": (r.get("snippet") or "")[:500],
            }
            for r in results
        ]
        _log_knowledge_event(
            session_id,
            event_type="opsidian_search",
            source="Opsidian",
            engine="legacy.keyword",
            message=(
                f"opsidian_search: '{query[:60]}' → {len(items)} hits"
            ),
            hits=len(items),
            top_score=items[0]["score"] if items else None,
        )
        # Decorate with ViewLedger so repeated searches surface
        # "previously seen" hints just like knowledge_search does.
        _maybe_decorate_results(session_id, items=items, event="searched")
        return _ok({
            "query": query,
            "total": len(items),
            "results": items,
            "engine": "opsidian.keyword",
        })

    async def arun(
        self,
        session_id: str,
        query: str,
        max_results: int = 5,
    ) -> str:
        config = _get_ltm_config()
        if config is None or not config.user_opsidian_index_enabled:
            return _error("User Opsidian index access is not enabled")
        _, opsidian = _get_context_managers(session_id)
        if opsidian is None:
            return _error("User Opsidian manager not available")
        if not query or not query.strip():
            return _error("query is required")

        warning = await self._asize_guard(opsidian)
        if warning is not None:
            return _ok({
                "query": query, "total": 0, "results": [],
                "engine": "opsidian.keyword", "warning": warning,
            })

        asearch = getattr(opsidian, "asearch", None)
        results = (
            await asearch(query, max_results=max_results)
            if callable(asearch)
            else opsidian.search(query, max_results=max_results)
        )
        items = [
            {
                "filename": r.get("filename"),
                "title": r.get("title"),
                "category": r.get("category"),
                "tags": r.get("tags"),
                "importance": r.get("importance"),
                "score": round(float(r.get("score", 0) or 0), 4),
                "snippet": (r.get("snippet") or "")[:500],
            }
            for r in results
        ]
        _log_knowledge_event(
            session_id,
            event_type="opsidian_search",
            source="Opsidian",
            engine="legacy.keyword",
            message=(
                f"opsidian_search: '{query[:60]}' → {len(items)} hits"
            ),
            hits=len(items),
            top_score=items[0]["score"] if items else None,
        )
        _maybe_decorate_results(session_id, items=items, event="searched")
        return _ok({
            "query": query,
            "total": len(items),
            "results": items,
            "engine": "opsidian.keyword",
        })

    # ── Size guard helpers ───────────────────────────────────────

    @staticmethod
    def _max_notes() -> int:
        import os as _os
        try:
            return int(
                _os.environ.get(
                    "GENY_WHITEBOARD_OPSIDIAN_SEARCH_MAX_NOTES", "500"
                )
            )
        except ValueError:
            return 500

    def _size_guard(self, opsidian: Any) -> Optional[str]:
        """Return a ``warning`` string when the vault is too large
        to scan safely on this turn; ``None`` means proceed.

        ``UserOpsidianManager.search`` reads every note's body to
        score it (an N+1 fetch). For huge vaults that's too slow on
        the agent's hot path, so we short-circuit with a clear
        warning that the agent can relay to the user.
        """
        try:
            notes = opsidian.list_notes()
        except Exception:  # noqa: BLE001
            return None  # let the underlying search raise normally
        cap = self._max_notes()
        if len(notes) > cap:
            return (
                f"Vault has {len(notes)} notes; opsidian_search caps "
                f"out at {cap} for performance. Use opsidian_browse "
                f"with a category or tag filter to narrow the scope, "
                f"then opsidian_read on the result you want."
            )
        return None

    async def _asize_guard(self, opsidian: Any) -> Optional[str]:
        """Async sibling of :meth:`_size_guard`."""
        alist = getattr(opsidian, "alist_notes", None)
        try:
            notes = (
                await alist() if callable(alist) else opsidian.list_notes()
            )
        except Exception:  # noqa: BLE001
            return None
        cap = self._max_notes()
        if len(notes) > cap:
            return (
                f"Vault has {len(notes)} notes; opsidian_search caps "
                f"out at {cap} for performance. Use opsidian_browse "
                f"with a category or tag filter to narrow the scope, "
                f"then opsidian_read on the result you want."
            )
        return None


# ============================================================================
# Explicit TOOLS list for ToolLoader
# ============================================================================

TOOLS = [
    KnowledgeSearchTool(),
    KnowledgeReadTool(),
    KnowledgeListTool(),
    KnowledgePromoteTool(),
    OpsidianBrowseTool(),
    OpsidianReadTool(),
    OpsidianSearchTool(),
]
