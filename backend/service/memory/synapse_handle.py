"""Synapse vector handle — wraps geny-memory-adaptor's SynapseMemory as a
geny-executor ``VectorHandle`` so the file memory provider's semantic layer
runs on the local, learnable, zero-API-call Synapse engine.

The file provider keeps STM/LTM/Notes as markdown; only the vector layer is
replaced. Notes are indexed into Synapse on write (``attach_vector_indexer``
→ ``index(ref, body)``), semantic retrieval routes through ``search()`` (the
Stage-2 retriever's L3 layer calls ``provider.vector().search(...)``), and each
hit's ``content`` is filled from Synapse's own stored body (``get_text``), so
there is no second copy of the corpus and no embedding API call.

Structural match for ``geny_executor.memory.provider.VectorHandle`` — plus the
``vector_disabled`` / ``disabled_reason`` attributes the file provider reads off
the concrete store.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional, Sequence, Tuple

import numpy as np
from geny_memory_adaptor import FEATURES

from geny_executor.memory.provider import (
    EmbeddingDescriptor,
    NoteRef,
    ReindexPlan,
)
from geny_executor.stages.s02_context.types import MemoryChunk

logger = logging.getLogger(__name__)


def _node_id(ref: NoteRef) -> str:
    """Stable id for a note across scope/category — the vector store's key."""
    parts = [getattr(ref, "scope", None), getattr(ref, "category", None),
             ref.filename]
    return "/".join(str(p) for p in parts if p)


def _feature_vector(hit) -> Optional[np.ndarray]:
    """SearchHit.features (a name→value dict) → the ordered raw feature vector
    the ranker learns on. Returns None if the hit carries no features."""
    f = getattr(hit, "features", None)
    if not f:
        return None
    return np.array([f.get(name, 0.0) for name in FEATURES], dtype=np.float32)


class SynapseVectorHandle:
    """Duck-typed ``VectorHandle`` backed by a local Synapse engine.

    Beyond the executor's search-only contract, this handle also closes the
    LEARNING loop: ``search`` records each query's shown notes + feature vectors
    into a per-session usage tracker, and ``feedback`` forwards a trusted
    positive/negative split to ``SynapseMemory.learn``. Retrieval itself is never
    treated as a reward — only Geny-observed external signals are (see
    ``usage_tracker``)."""

    #: Read by FileMemoryProvider._build_descriptor / capability gating.
    vector_disabled = False
    disabled_reason = ""

    def __init__(self, memory, *, dim: int, usage_tracker: Any = None) -> None:
        # `memory` is a geny_memory_adaptor.SynapseMemory (lazy-typed to avoid a
        # hard import when the extra isn't installed).
        self._m = memory
        self._dim = dim
        #: Set by provider_bridge; search feeds it, the session flushes it.
        self.usage_tracker = usage_tracker

    @property
    def descriptor(self) -> EmbeddingDescriptor:
        return EmbeddingDescriptor(
            provider="synapse",
            model="synapse-hash-static",
            dimension=self._dim,
            metric="cosine",
            api_key_present=False,
        )

    async def index(self, ref: NoteRef, text: str) -> int:
        # Executor calls this off the write lock; Synapse ops are sync CPU ms.
        self._m.index(
            _node_id(ref), text,
            kind=str(getattr(ref, "category", None) or "note"),
        )
        return 1

    async def index_batch(self, items: Sequence[Tuple[NoteRef, str]]) -> int:
        for ref, text in items:
            self._m.index(_node_id(ref), text,
                          kind=str(getattr(ref, "category", None) or "note"))
        return len(items)

    async def search(self, text: str, *, top_k: int = 5,
                     threshold: float = 0.0) -> List[MemoryChunk]:
        hits = self._m.search(text, top_k=top_k)
        # Record provenance for learning BEFORE thresholding — a note that just
        # missed the score cut is still a valid negative for this query.
        tracker = self.usage_tracker
        if tracker is not None and hits:
            try:
                # Query TEXT is the learning key (stable across turns → keeps a
                # query on one side of the blend gate's hold-out), not the
                # per-call query_token (which varies every search).
                tracker.record_search(
                    text, [(h.id, _feature_vector(h)) for h in hits],
                    titles={h.id: h.title for h in hits if h.title})
            except Exception:  # noqa: BLE001 — never break retrieval
                logger.debug("usage_tracker.record_search failed", exc_info=True)
        out: List[MemoryChunk] = []
        for h in hits:
            if h.score < threshold:
                continue
            body = self._m.get_text(h.id) or h.title or ""
            out.append(MemoryChunk(
                key=h.id,
                content=body,
                source="vector",
                relevance_score=float(h.score),
                metadata={"engine": "synapse", "sources": h.sources,
                          "query_token": h.query_token, "kind": h.kind},
            ))
        return out

    def feedback(self, query_key: str, *,
                 positives: Sequence[Tuple[str, Any]],
                 negatives: Sequence[Any],
                 label_src: str = "implicit") -> dict:
        """Forward a trusted usefulness signal to Synapse's cross-turn learner.

        *positives* is ``[(note_id, feature_vector), ...]`` for notes an external
        signal confirmed useful; *negatives* is the feature vectors of the same
        query's shown-but-unflagged notes. Synchronous CPU-ms; the caller (the
        session's end-of-turn flush) runs it off the hot path."""
        return self._m.learn(query_key, positives=positives,
                             negatives=negatives, label_src=label_src)

    async def remove(self, ref: NoteRef) -> bool:
        self._m.remove(_node_id(ref))
        return True

    async def reindex(self, *, plan: Optional[ReindexPlan] = None) -> ReindexPlan:
        # Synapse indexes are incremental + derived; distillation is the only
        # batch maintenance and needs no external tokens/cost.
        metrics = self._m.distill()
        return ReindexPlan(
            layer="vector",
            reason="synapse distill (local, zero-cost)",
            chunks_to_reindex=int(metrics.get("pairs", 0)),
            estimated_tokens=0,
            estimated_cost_usd=0.0,
            requires_explicit_approval=False,
        )

    async def fetch_document(self, ref: NoteRef, *,
                             max_chunks: int = 5000) -> List[MemoryChunk]:
        # Synapse stores one vector per note (no sub-chunking), so a document is
        # its single chunk.
        nid = _node_id(ref)
        body = self._m.get_text(nid)
        if body is None:
            return []
        return [MemoryChunk(key=nid, content=body, source="vector",
                            relevance_score=1.0, metadata={"engine": "synapse"})]

    def close(self) -> None:
        try:
            self._m.close()
        except Exception:  # noqa: BLE001
            logger.debug("synapse close failed", exc_info=True)
