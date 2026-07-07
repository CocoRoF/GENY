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


class _FakeChunk:
    """MemoryChunk-shaped object for fetch_document."""

    def __init__(self, content, metadata):
        self.content = content
        self.metadata = metadata


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

    async def fetch_document(self, ref, *, max_chunks=5000):
        out = []
        for i, dc in enumerate(self.indexed.get(ref.filename, [])):
            meta = dict(getattr(dc, "metadata", {}) or {})
            meta.setdefault("chunk_index", i)
            out.append(_FakeChunk(dc.text, meta))
        return out


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
    monkeypatch.setattr(ks, "_resolve_embedding_key", lambda provider: "")
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
    monkeypatch.setattr(ks, "_resolve_embedding_key", lambda provider: "sk-stale")
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
    monkeypatch.setattr(ks, "_resolve_embedding_key", lambda provider: current["key"])
    service = ks.KnowledgeService("rotator")

    store1 = service._vector()
    embedder1 = service._embedder
    assert service._vector() is store1  # unchanged key → cached

    current["key"] = "sk-new"
    store2 = service._vector()
    assert store2 is not store1
    assert service._embedder is not embedder1


def test_collection_is_per_user_and_model():
    assert (
        ks._collection_for("User-1", "text-embedding-3-large")
        == "geny_kb__user_1__text_embedding_3_large"
    )


@pytest.mark.asyncio
async def test_embedding_model_recorded_stale_and_reembed(svc, monkeypatch):
    """Card records the model that embedded it; switching the common
    embedding setting marks docs stale; reembed repairs from the stored
    original and re-records the current model."""
    service, fake = svc
    monkeypatch.setattr(
        ks, "_embedding_spec",
        lambda: ("openai", "text-embedding-3-large", 3072),
    )
    out = await service.ingest_file(
        filename="policy.md", data=("규정 본문 문단. " * 150).encode("utf-8"),
    )
    assert out["status"] == "ready"
    row = next(
        d for d in await service.list_documents() if d["doc_id"] == out["doc_id"]
    )
    assert row["embedding_model"] == "text-embedding-3-large"
    assert row["embedding_stale"] is False

    # Common embedding setting changes → the doc is now stale.
    monkeypatch.setattr(
        ks, "_embedding_spec",
        lambda: ("openai", "text-embedding-3-small", 1536),
    )
    row = next(
        d for d in await service.list_documents() if d["doc_id"] == out["doc_id"]
    )
    assert row["embedding_stale"] is True

    # Re-embed from the stored attachment under the current model.
    fake.indexed.clear()
    res = await service.reembed_document(out["doc_id"])
    assert res["status"] == "ready" and res["chunks"] >= 1
    assert f"doc-{out['doc_id']}.md" in fake.indexed
    row = next(
        d for d in await service.list_documents() if d["doc_id"] == out["doc_id"]
    )
    assert row["embedding_model"] == "text-embedding-3-small"
    assert row["embedding_stale"] is False


@pytest.mark.asyncio
async def test_korean_filename_preserved_in_title_and_original(svc):
    service, fake = svc
    out = await service.ingest_file(
        filename="빅데이터응용학과 시행세칙.md",
        data=("본문 문단입니다. " * 120).encode("utf-8"),
    )
    assert out["status"] == "ready"
    row = next(
        d for d in await service.list_documents() if d["doc_id"] == out["doc_id"]
    )
    assert row["title"] == "빅데이터응용학과 시행세칙.md"
    assert row["original_filename"] == "빅데이터응용학과 시행세칙.md"


@pytest.mark.asyncio
async def test_get_document_text_reassembles_full(svc):
    service, fake = svc
    body = "첫 문단. " * 200 + "PAYMENT_TIMEOUT=7500ms. " + "끝 문단. " * 50
    out = await service.ingest_file(filename="정책.md", data=body.encode("utf-8"))
    detail = await service.get_document_text(out["doc_id"])
    assert detail["title"] == "정책.md"
    assert "7500ms" in detail["text"]
    # Reassembled text is materially longer than the 400-char card preview.
    assert len(detail["text"]) > 400
    chunks = await service.get_document_chunks(out["doc_id"])
    assert chunks["chunk_count"] == out["chunks"]
    assert [c["chunk_index"] for c in chunks["chunks"]] == list(
        range(len(chunks["chunks"]))
    )


@pytest.mark.asyncio
async def test_reembed_preserves_korean_title(svc, monkeypatch):
    """A prior bug rebuilt the title from the mangled attachment name on
    re-embed. It must survive from original_filename instead."""
    service, fake = svc
    monkeypatch.setattr(
        ks, "_embedding_spec",
        lambda: ("openai", "text-embedding-3-large", 3072),
    )
    out = await service.ingest_file(
        filename="한글 문서.md", data=("본문. " * 120).encode("utf-8"),
    )
    monkeypatch.setattr(
        ks, "_embedding_spec",
        lambda: ("openai", "text-embedding-3-small", 1536),
    )
    res = await service.reembed_document(out["doc_id"])
    assert res["status"] == "ready"
    row = next(
        d for d in await service.list_documents() if d["doc_id"] == out["doc_id"]
    )
    assert row["title"] == "한글 문서.md"
    assert row["original_filename"] == "한글 문서.md"


@pytest.mark.asyncio
async def test_index_note_embeds_direct_note(svc):
    """A directly-created vault note gets embedded into the SAME knowledge
    index (consistency across supply paths), keyed by its real path, with
    source_type=note and no doc card."""
    service, fake = svc
    n = await service.index_note(
        filename="ideas/제품아이디어.md",
        title="제품 아이디어",
        text="신제품 결제 흐름은 3단계로 단순화한다. " * 60,
    )
    assert n >= 1
    indexed = fake.indexed["ideas/제품아이디어.md"]
    assert indexed[0].metadata["source_type"] == "note"
    assert indexed[0].metadata["title"] == "제품 아이디어"
    # A note is NOT a document card — it doesn't show in list_documents.
    docs = await service.list_documents()
    assert all(d["filename"] != "ideas/제품아이디어.md" for d in docs)


@pytest.mark.asyncio
async def test_index_note_skips_doc_cards(svc):
    """Managed document cards are already indexed by ingest — index_note
    must not double-index them."""
    service, fake = svc
    n = await service.index_note(
        filename="knowledge/doc-abc123def456.md", title="x", text="body " * 50,
    )
    assert n == 0
    assert "knowledge/doc-abc123def456.md" not in fake.indexed


@pytest.mark.asyncio
async def test_index_note_empty_removes(svc):
    service, fake = svc
    await service.index_note(filename="n.md", title="n", text="content " * 50)
    assert "n.md" in fake.indexed
    await service.index_note(filename="n.md", title="n", text="   ")
    assert "n.md" in fake.removed


def test_json_upload_uses_structured_rendering(svc):
    service, _ = svc
    rows = service._extract_chunks(
        "api.json", b'{"items": [{"id": 1, "name": "alpha"}]}',
    )
    assert rows and "items[0].name" in rows[0]["text"]
