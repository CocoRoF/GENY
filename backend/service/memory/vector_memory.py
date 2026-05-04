"""Thin adapter — delegates every vector op to the executor MemoryProvider.

Pre-Phase-2 this module ran a self-hosted FAISS index plus its own
HTTP-direct embedding clients (OpenAI / Voyage / Google). Phase 2
demolished that — the executor's `MemoryProvider.vector()` handle
now owns indexing + search, and this file is an adapter that
preserves the *external* surface (``VectorMemoryManager.search`` /
``index_text`` / ``initialize`` / ``enabled``) the rest of Geny —
specifically the ``geny_executor.memory.retriever.GenyMemoryRetriever``
that still calls ``mgr.vector_memory.search(...)`` — already expects.

Why an adapter and not a direct rewrite of every caller? Two reasons:

1. The retriever lives inside the geny-executor library and treats
   ``mgr.vector_memory`` as a *duck-typed* surface (``.enabled``,
   ``.search()``, ``.index_text()``). Rewriting the executor was out
   of scope; preserving the surface keeps the retriever working
   while the embedding work moves under the executor's
   ``EmbeddingClient`` machinery.
2. ``faiss-cpu`` and the self-hosted embedding clients can be
   removed from Geny's dep set the moment this module stops
   importing them — no dependency cascade through manager.py.

Result is a small, well-typed shim. ``VectorSearchResult`` is
re-exported with the same shape it had in the legacy ``vector_store``
module so existing callers (``manager.build_memory_context_async``,
``GenyMemoryRetriever._load_vector_memory``) consume identical
objects.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from logging import getLogger
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)


# ── Search result (legacy shape, kept for retriever compatibility) ─────

@dataclass
class VectorSearchResult:
    """Single hit from a vector similarity search.

    Mirrors the dataclass that lived under the old `service.memory.
    vector_store` so any caller that read `.text` / `.source_file` /
    `.score` / `.chunk_index` keeps working without modification.
    """

    text: str
    source_file: str
    score: float
    chunk_index: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


def chunk_text(*args, **kwargs):
    """Backwards-compat re-export kept for any caller that still imports
    `chunk_text` from `service.memory.vector_memory`. The executor
    handles chunking internally now (per `EmbeddingClient` config)
    so this proxies into the executor helper to keep behaviour
    consistent if any straggler caller surfaces.
    """
    from geny_executor.memory.providers.file.vector_store import chunk_text as _impl

    return _impl(*args, **kwargs)


# ── Manager (executor-backed adapter) ───────────────────────────────────


class VectorMemoryManager:
    """Vector-layer adapter on top of the executor's `composite.vector()`.

    The constructor still accepts ``storage_path`` / ``session_id`` so
    legacy build sites (``SessionMemoryManager.__init__``) don't have
    to change. ``set_memory_provider`` lets the surrounding
    ``SessionMemoryManager`` plug the live executor provider in once
    ``AgentSession.initialize()`` has built it — providers come up
    lazily so the manager constructs without one and learns about it
    later.

    All async operations no-op until a provider with a vector handle
    has been attached. The retriever's ``.enabled`` check uses the
    same property so an embedding-disabled session degrades to
    keyword-only retrieval gracefully.
    """

    def __init__(
        self,
        storage_path: str,
        *,
        session_id: str = "",
        memory_provider: Optional[Any] = None,
    ) -> None:
        self._storage_path = storage_path
        self._session_id = session_id
        self._provider: Optional[Any] = memory_provider

    # ── Wiring ────────────────────────────────────────────────────────

    def set_memory_provider(self, provider: Optional[Any]) -> None:
        """Attach the live `MemoryProvider` once it's been built.

        AgentSession calls this after `_init_memory_provider` so the
        session's vector handle is reachable from `mgr.vector_memory`.
        """
        self._provider = provider

    @property
    def memory_provider(self) -> Optional[Any]:
        return self._provider

    @property
    def store(self) -> Optional[Any]:
        """Legacy accessor kept for completeness — returns the
        executor `VectorHandle` when one is attached, otherwise None.
        Geny code rarely reaches for this directly."""
        if self._provider is None:
            return None
        return self._provider.vector()

    # ── Properties used by retriever / manager ────────────────────────

    @property
    def enabled(self) -> bool:
        return self._provider is not None and self._provider.vector() is not None

    @property
    def initialized(self) -> bool:
        return self.enabled

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def initialize(self) -> bool:
        """No-op: the executor `MemoryProvider` is initialised by
        `AgentSession._init_memory_provider`. Returning the enabled
        state lets `SessionMemoryManager.initialize_vector_memory`
        keep its `if ok: index_memory_files()` flow.
        """
        return self.enabled

    def save(self) -> None:
        """No-op — the executor's file vector store flushes on every
        write. Kept on the API so legacy `auto_flush` paths that call
        ``self._vmm.save()`` stay valid."""
        return None

    # ── Indexing ──────────────────────────────────────────────────────

    async def index_memory_files(self) -> Dict[str, int]:
        """Index every existing markdown note via the executor's
        `VectorHandle.index_batch`.

        Run once on session boot so a revived session whose disk
        already carries notes from a previous run gets those rows
        into the vector store. New writes route through
        `notes_store.attach_vector_indexer` automatically.
        """
        if not self.enabled or self._provider is None:
            return {}

        try:
            from geny_executor.memory.provider import NoteRef, Scope

            notes_handle = self._provider.notes()
            vector_handle = self._provider.vector()
            metas = await notes_handle.list()
            items: List = []
            for m in metas:
                note = await notes_handle.read(m.ref.filename)
                if note is None or not note.body:
                    continue
                items.append((note.ref, note.body))
            if not items:
                return {}
            added = await vector_handle.index_batch(items)
            logger.info(
                "VectorMemoryManager.index_memory_files: indexed %d existing note(s)",
                added,
            )
            return {f.filename: 1 for f, _ in items}
        except Exception:
            logger.warning(
                "VectorMemoryManager.index_memory_files failed",
                exc_info=True,
            )
            return {}

    async def index_text(
        self,
        text: str,
        source_file: str,
        *,
        replace: bool = False,
    ) -> int:
        """Index a single piece of text — used by `record_execution` to
        embed the per-turn execution log.

        ``replace`` is honoured for parity with the legacy API; the
        executor's `VectorHandle.index` already replaces rows keyed by
        the same NoteRef filename, so there is nothing extra to do.
        """
        if not self.enabled or self._provider is None or not text:
            return 0
        try:
            from geny_executor.memory.provider import NoteRef, Scope

            ref = NoteRef(
                filename=source_file,
                scope=Scope.SESSION,
                backend="filesystem",
            )
            return await self._provider.vector().index(ref, text)
        except Exception:
            logger.warning(
                "VectorMemoryManager.index_text failed (source=%s)",
                source_file, exc_info=True,
            )
            return 0

    # ── Search ────────────────────────────────────────────────────────

    async def search(
        self,
        query: str,
        *,
        top_k: Optional[int] = None,
    ) -> List[VectorSearchResult]:
        """Cosine-similarity search via the executor `VectorHandle`.

        Returns legacy-shaped `VectorSearchResult` records so the
        retriever's iteration code (`vr.text`, `vr.source_file`,
        `vr.score`, `vr.chunk_index`) keeps working without
        modification.
        """
        if not self.enabled or self._provider is None or not query:
            return []
        try:
            top_k_eff = top_k if top_k is not None else 6
            chunks = await self._provider.vector().search(query, top_k=top_k_eff)
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
        except Exception:
            logger.warning(
                "VectorMemoryManager.search failed", exc_info=True,
            )
            return []

    def build_vector_context(
        self,
        results: List[VectorSearchResult],
        *,
        max_chars: int = 5000,
    ) -> str:
        """Render `search()` results into the XML block the prompt
        builder injects. Same shape as the legacy implementation:

            <vector-memory source="..." score="...">
            <body>
            </vector-memory>
        """
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


__all__ = [
    "VectorMemoryManager",
    "VectorSearchResult",
    "chunk_text",
]
