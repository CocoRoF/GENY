"""Local Synapse backend for the knowledge repository — a drop-in replacement
for ``QdrantVectorStore`` that makes zero embedding-API calls.

``KnowledgeService`` reaches its vector backend through a small handle protocol
(``index_document`` / ``search`` / ``fetch_document`` / ``remove`` +
``descriptor``). This module implements that exact protocol over a local
``SynapseMemory`` engine (BM25 + local static embeddings + graph), so uploaded
documents and Opsidian notes become searchable with no OpenAI/qdrant and no key.

Document model
--------------
A document (one ``NoteRef.filename``) is split by the service into ordered
chunks. Each chunk is one Synapse node keyed ``"<filename>#<chunk_index>"``; its
rich payload (doc_id, title, page, heading, source_type, …) is stored alongside
in the Synapse db's ``params`` table under ``"kmeta:<node_id>"`` (Synapse nodes
carry only title/kind/text, so the payload rides in params). A per-document
``"kdoc:<filename>"`` param records the chunk count so remove/fetch can walk a
document's chunks without a payload filter — the same role qdrant's
filter-by-filename plays. Per-user isolation is one SQLite file per collection,
mirroring qdrant's per-(user, model) collection.
"""

from __future__ import annotations

import json
import logging
from typing import Any, List, Optional, Sequence

from geny_executor.memory.provider import EmbeddingDescriptor, NoteRef
from geny_executor.stages.s02_context.types import MemoryChunk

logger = logging.getLogger(__name__)


def _meta_key(node_id: str) -> str:
    return f"kmeta:{node_id}"


def _doc_key(filename: str) -> str:
    return f"kdoc:{filename}"


class KnowledgeSynapseStore:
    """Document-chunk vector store backed by a local Synapse engine.

    Shape-matches the subset of ``QdrantVectorStore`` that ``KnowledgeService``
    uses: ``descriptor``, ``index_document``, ``search``, ``fetch_document``,
    ``remove``, ``close``. All Synapse ops are synchronous CPU-milliseconds; the
    async methods just wrap them so the service's ``await`` sites are unchanged.
    """

    def __init__(self, memory, *, dim: int, model: str = "synapse-hash-static") -> None:
        # `memory` is a geny_memory_adaptor.SynapseMemory (lazy-typed).
        self._m = memory
        self._dim = dim
        self._model = model

    @property
    def descriptor(self) -> EmbeddingDescriptor:
        return EmbeddingDescriptor(
            provider="synapse",
            model=self._model,
            dimension=self._dim,
            metric="cosine",
            api_key_present=False,
        )

    # ── write ────────────────────────────────────────────────────────
    async def index_document(self, ref: NoteRef, chunks: Sequence[Any]) -> int:
        """Replace all of *ref*'s chunks with *chunks* (delete-then-insert), one
        Synapse node per chunk. Returns the chunk count. ``chunks`` items are
        ``DocumentChunk``-like: ``.text`` + ``.metadata`` (a dict)."""
        filename = ref.filename
        await self.remove(ref)
        store = self._m.store
        count = 0
        for i, ch in enumerate(chunks):
            text = getattr(ch, "text", "") or ""
            meta = dict(getattr(ch, "metadata", None) or {})
            meta["chunk_index"] = i
            meta["filename"] = filename
            nid = f"{filename}#{i}"
            self._m.index(nid, text, title=str(meta.get("title") or ""),
                          kind="knowledge")
            store.put_param(_meta_key(nid),
                            json.dumps(meta, ensure_ascii=False).encode("utf-8"))
            count += 1
        store.put_param(_doc_key(filename),
                        json.dumps({"count": count}).encode("utf-8"))
        return count

    # ── read ─────────────────────────────────────────────────────────
    async def search(self, text: str, *, top_k: int = 5,
                     threshold: float = 0.0) -> List[MemoryChunk]:
        hits = self._m.search(text, top_k=top_k)
        out: List[MemoryChunk] = []
        for h in hits:
            if h.score < threshold:
                continue
            meta = self._get_meta(h.id)
            body = self._m.get_text(h.id) or h.title or ""
            out.append(MemoryChunk(
                key=h.id, content=body, source="knowledge",
                relevance_score=float(h.score), metadata=meta))
        return out

    async def fetch_document(self, ref: NoteRef, *,
                             max_chunks: int = 5000) -> List[MemoryChunk]:
        """All chunks of *ref*, ordered by chunk_index; ``content`` = full text."""
        count = self._doc_count(ref.filename)
        out: List[MemoryChunk] = []
        for i in range(min(count, max_chunks)):
            nid = f"{ref.filename}#{i}"
            body = self._m.get_text(nid)
            if body is None:
                continue
            out.append(MemoryChunk(
                key=nid, content=body, source="knowledge",
                relevance_score=1.0, metadata=self._get_meta(nid)))
        return out

    async def remove(self, ref: NoteRef) -> bool:
        """Delete every chunk (node + payload) of *ref.filename*."""
        filename = ref.filename
        count = self._doc_count(filename)
        store = self._m.store
        for i in range(count):
            nid = f"{filename}#{i}"
            self._m.remove(nid)
            store.delete_param(_meta_key(nid))
        store.delete_param(_doc_key(filename))
        return True

    # ── helpers ──────────────────────────────────────────────────────
    def _get_meta(self, node_id: str) -> dict:
        blob = self._m.store.get_param(_meta_key(node_id))
        if not blob:
            return {}
        try:
            return json.loads(blob.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _doc_count(self, filename: str) -> int:
        blob = self._m.store.get_param(_doc_key(filename))
        if not blob:
            return 0
        try:
            return int(json.loads(blob.decode("utf-8")).get("count", 0))
        except Exception:  # noqa: BLE001
            return 0

    def close(self) -> None:
        try:
            self._m.close()
        except Exception:  # noqa: BLE001
            logger.debug("knowledge synapse close failed", exc_info=True)


def build_knowledge_synapse_store(*, db_path: str, dim: int,
                                  model: str = "synapse-hash-static") -> Optional["KnowledgeSynapseStore"]:
    """Assemble a KnowledgeSynapseStore at *db_path*, or None if the adaptor is
    not installed (caller can then surface a clear error)."""
    try:
        import os

        from geny_memory_adaptor import SynapseConfig, SynapseMemory
    except Exception:  # noqa: BLE001
        logger.warning("knowledge: geny-memory-adaptor not available", exc_info=True)
        return None
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    # store_text generous: knowledge chunks are ~1200 chars but can be larger;
    # keep the full chunk so fetch_document/search return lossless content.
    mem = SynapseMemory(SynapseConfig(
        path=db_path, dim=dim, store_text=True, store_text_maxlen=100_000))
    return KnowledgeSynapseStore(mem, dim=dim, model=model)
