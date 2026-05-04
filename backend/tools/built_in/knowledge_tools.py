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
            return _error(f"Note not found: {filename}")
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
]
