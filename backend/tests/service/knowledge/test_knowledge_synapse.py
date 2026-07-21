"""Knowledge repository on the local Synapse backend (the default engine):
document-chunk index/search/fetch/remove with zero API calls and no key.
"""

from __future__ import annotations

import os
import tempfile

import pytest

from geny_executor.memory.provider import NoteRef, Scope

try:
    from geny_executor.memory import DocumentChunk
except Exception:  # pragma: no cover
    from geny_executor.memory.vector.qdrant_store import DocumentChunk

from service.knowledge.synapse_store import build_knowledge_synapse_store


def _chunks():
    return [
        DocumentChunk(text="리듬게임 판정 타이밍과 콤보 시스템",
                      metadata={"doc_id": "d1", "title": "게임", "source_type": "upload", "page": 1}),
        DocumentChunk(text="김치찌개 끓이는 법 돼지고기 두부",
                      metadata={"doc_id": "d1", "title": "게임", "source_type": "upload", "page": 2}),
    ]


@pytest.mark.asyncio
async def test_synapse_store_roundtrip(tmp_path):
    store = build_knowledge_synapse_store(db_path=str(tmp_path / "kb.db"), dim=128)
    assert store is not None
    assert store.descriptor.provider == "synapse"
    assert store.descriptor.api_key_present is False

    ref = NoteRef(filename="doc-d1.md", scope=Scope.USER, category="knowledge")
    n = await store.index_document(ref, _chunks())
    assert n == 2

    hits = await store.search("리듬게임 콤보", top_k=2)
    assert hits and hits[0].key == "doc-d1.md#0"
    # payload survived through the params table
    assert hits[0].metadata["doc_id"] == "d1"
    assert hits[0].metadata["chunk_index"] == 0
    assert hits[0].metadata["page"] == 1

    doc = await store.fetch_document(ref)
    assert [c.metadata["page"] for c in doc] == [1, 2]  # ordered by chunk_index

    assert await store.remove(ref) is True
    assert await store.search("리듬게임", top_k=5) == []
    assert await store.fetch_document(ref) == []
    store.close()


@pytest.mark.asyncio
async def test_index_document_replaces_previous_chunks(tmp_path):
    store = build_knowledge_synapse_store(db_path=str(tmp_path / "kb.db"), dim=128)
    ref = NoteRef(filename="doc-x.md", scope=Scope.USER, category="knowledge")
    await store.index_document(ref, _chunks())  # 2 chunks
    await store.index_document(ref, _chunks()[:1])  # re-index with 1
    doc = await store.fetch_document(ref)
    assert len(doc) == 1  # stale second chunk gone
    store.close()


@pytest.mark.asyncio
async def test_service_synapse_needs_no_key(tmp_path, monkeypatch):
    import service.knowledge.service as ks

    monkeypatch.setattr(ks, "_memory_engine", lambda: "synapse")
    monkeypatch.setattr(ks, "_knowledge_db_path",
                        lambda username, model: str(tmp_path / f"{username}.db"))
    # No embedding key anywhere.
    monkeypatch.setattr(ks, "_resolve_embedding_key", lambda provider: "")

    svc = ks.KnowledgeService("tester")
    await svc.verify_embedding()  # must NOT raise under synapse
    st = svc.status()
    assert st["embedding_provider"] == "synapse"
    assert st["embedding_ready"] is True
    assert st["embedding_key_state"] == "local"
    assert type(svc._vector()).__name__ == "KnowledgeSynapseStore"
