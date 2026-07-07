"""Knowledge repository P1 — upload pipeline over the user vault.

Real Contextifier extraction + real UserOpsidianManager on a tmp vault;
the qdrant store is faked (captures DocumentChunks) so the contract under
test is: bytes → chunks with provenance → indexed points → document card
note with status frontmatter, and delete removes card+attachment+vectors.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

import service.knowledge.service as ks


class _FakeStore:
    def __init__(self):
        self.indexed: Dict[str, List[Any]] = {}
        self.removed: List[str] = []

    async def index_document(self, ref, chunks):
        self.indexed[ref.filename] = list(chunks)
        return len(chunks)

    async def search(self, query, top_k=8):
        return []

    async def remove(self, ref):
        self.removed.append(ref.filename)
        return True


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    import service.memory.user_opsidian as uo

    monkeypatch.setattr(
        uo.UserOpsidianManager, "_default_path",
        staticmethod(lambda: str(tmp_path)),
    )
    uo._user_managers.clear()

    service = ks.KnowledgeService("tester")
    fake = _FakeStore()
    monkeypatch.setattr(service, "_vector", lambda: fake)
    yield service, fake
    uo._user_managers.clear()


@pytest.mark.asyncio
async def test_ingest_markdown_creates_card_and_chunks(svc):
    service, fake = svc
    text = "# 제품 개요\n\n" + ("지식 저장소 본문 문단입니다. " * 120)
    out = await service.ingest_file(
        filename="guide.md", data=text.encode("utf-8"),
    )
    assert out["status"] == "ready"
    assert out["chunks"] >= 1

    card = out["filename"]
    assert card.startswith("doc-") and card.endswith(".md")
    chunks = fake.indexed[card]
    assert chunks and chunks[0].metadata["doc_id"] == out["doc_id"]
    assert chunks[0].metadata["title"] == "guide.md"
    assert any(c.metadata.get("heading") for c in chunks)

    docs = await service.list_documents()
    row = next(d for d in docs if d["doc_id"] == out["doc_id"])
    assert row["status"] == "ready"
    assert row["chunk_count"] == out["chunks"]
    assert row["source_type"] == "upload"


@pytest.mark.asyncio
async def test_ingest_failure_lands_on_card(svc):
    service, fake = svc

    async def boom(*a, **k):
        raise RuntimeError("embedding down")

    fake.index_document = boom
    out = await service.ingest_file(filename="x.md", data=b"# t\ncontent here")
    assert out["status"] == "failed"
    docs = await service.list_documents()
    assert any(d["status"] == "failed" for d in docs)


@pytest.mark.asyncio
async def test_delete_document_cleans_everything(svc, tmp_path):
    service, fake = svc
    out = await service.ingest_file(filename="del.md", data=b"# d\n" + b"x" * 300)
    doc_id = out["doc_id"]
    assert await service.delete_document(doc_id)
    assert f"doc-{doc_id}.md" in fake.removed
    docs = await service.list_documents()
    assert all(d["doc_id"] != doc_id for d in docs)
    att_dir = tmp_path / "_user_opsidian" / "tester" / "_attachments"
    leftovers = (
        list(att_dir.glob(f"knowledge-{doc_id}-*")) if att_dir.exists() else []
    )
    assert leftovers == []


def test_missing_key_raises_actionable_reason(monkeypatch):
    monkeypatch.setattr(ks, "_resolve_openai_key", lambda: "")
    service = ks.KnowledgeService("nokey")
    with pytest.raises(ks.KnowledgeUnavailable) as exc:
        service._vector()
    assert exc.value.reason == "openai_key_missing"


@pytest.mark.asyncio
async def test_rejected_key_raises_openai_key_invalid(monkeypatch):
    """A non-empty but 401-rejected key must surface as an actionable
    reason (the vector store swallows embed errors by design)."""
    from geny_executor.memory.embedding.client import EmbeddingError

    ks._KEY_VALIDITY.clear()
    monkeypatch.setattr(ks, "_resolve_openai_key", lambda: "sk-stale")
    service = ks.KnowledgeService("badkey")
    service._store = object()  # bypass real store construction

    calls = {"n": 0}

    class _RejectingEmbedder:
        async def embed(self, texts):
            calls["n"] += 1
            raise EmbeddingError("401 unauthorized", category="auth")

    service._embedder = _RejectingEmbedder()
    with pytest.raises(ks.KnowledgeUnavailable) as exc:
        await service.verify_embedding()
    assert exc.value.reason == "openai_key_invalid"

    # Verdict is cached per key value — no repeat ping.
    with pytest.raises(ks.KnowledgeUnavailable):
        await service.verify_embedding()
    assert calls["n"] == 1
    assert service.status()["embedding_ready"] is False
    ks._KEY_VALIDITY.clear()


def test_vector_rebuilds_on_key_rotation(monkeypatch):
    """A key rotated in settings must rebuild the embedder — otherwise
    the cached client keeps pinging with the RETIRED key and poisons the
    new key's validity verdict (observed on prod 2026-07-07)."""
    current = {"key": "sk-old"}
    monkeypatch.setattr(ks, "_resolve_openai_key", lambda: current["key"])
    service = ks.KnowledgeService("rotator")

    store1 = service._vector()
    embedder1 = service._embedder
    assert service._vector() is store1  # unchanged key → cached

    current["key"] = "sk-new"
    store2 = service._vector()
    assert store2 is not store1
    assert service._embedder is not embedder1


def test_json_upload_uses_structured_rendering(svc):
    service, _ = svc
    rows = service._extract_chunks(
        "api.json", b'{"items": [{"id": 1, "name": "alpha"}]}',
    )
    assert rows and "items[0].name" in rows[0]["text"]
