"""KnowledgeService — the user vault as a knowledge repository.

Design (2026-07 knowledge-repository plan):

* **The user vault IS the knowledge space.** Uploaded documents keep their
  original bytes in the vault's ``_attachments/`` area and appear as a
  "document card" note in the ``knowledge`` category — so the sidebar,
  graph, keyword search, and the Opsidian UI all see them like any other
  note. Auto-collected content (connectors) lands the same way.
* **Contextifier converts, executor embeds, qdrant serves.** Extraction +
  chunking is `contextifier` (`extract_chunks` with position metadata:
  page/heading/sheet per chunk); embeddings are the executor's OpenAI
  client (``text-embedding-3-large``, 3072-dim, fixed for now); vectors
  live in a per-user qdrant collection via the executor's
  ``QdrantVectorStore`` (one point per chunk, payload carries provenance).
* **Failures are visible, not silent.** A missing OpenAI key raises
  :class:`KnowledgeUnavailable` with ``reason="openai_key_missing"`` — the
  API layer maps it to a response that sends the UI to settings.

Ingestion is fire-and-forget (task-tracked); the document card's
``status`` frontmatter moves ``processing → ready | failed`` so the UI can
poll the document list.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from datetime import datetime, timezone
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)

KNOWLEDGE_CATEGORY = "knowledge"
EMBEDDING_MODEL = "text-embedding-3-large"
EMBEDDING_DIM = 3072
_CHUNK_SIZE = 1200
_CHUNK_OVERLAP = 150
_MAX_CHUNKS_PER_DOC = 2000


class KnowledgeUnavailable(RuntimeError):
    """Knowledge repo can't operate; ``reason`` is machine-readable
    (``openai_key_missing`` | ``qdrant_unavailable`` | ``contextifier_missing``)."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def _qdrant_url() -> str:
    return os.environ.get("GENY_QDRANT_URL", "http://qdrant:6333")


def _resolve_openai_key() -> str:
    """OpenAI key for embeddings: LTM embedding key first (explicit),
    then the general OpenAI API key."""
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.ltm_config import LTMConfig
        from service.config.sub_config.general.api_config import APIConfig

        cm = get_config_manager()
        ltm = cm.load_config(LTMConfig)
        key = (getattr(ltm, "embedding_api_key", "") or "").strip()
        if key:
            return key
        api = cm.load_config(APIConfig)
        return (getattr(api, "openai_api_key", "") or "").strip()
    except Exception:  # noqa: BLE001
        return (os.environ.get("OPENAI_API_KEY") or "").strip()


def _collection_for(username: str) -> str:
    safe = "".join(c if c.isalnum() else "_" for c in username.lower())
    return f"geny_kb__{safe or 'anonymous'}"


# sha1(key) → "ok" | "auth". A non-empty but REJECTED key otherwise fails
# silently inside the vector store (it swallows embed errors by design),
# leaving users staring at "failed" cards instead of a fix-your-key banner.
_KEY_VALIDITY: Dict[str, str] = {}


class KnowledgeService:
    """Per-user knowledge repository over the Opsidian user vault."""

    def __init__(self, username: str) -> None:
        self.username = username
        self._store = None  # lazy QdrantVectorStore
        self._embedder = None  # EmbeddingClient handle for verify_embedding

    # ── wiring ───────────────────────────────────────────────────────

    def _vault(self):
        from service.memory.user_opsidian import get_user_opsidian_manager

        return get_user_opsidian_manager(self.username)

    def _vector(self):
        if self._store is not None:
            return self._store
        key = _resolve_openai_key()
        if not key:
            raise KnowledgeUnavailable(
                "openai_key_missing",
                "OpenAI API key is required for knowledge embeddings "
                "(text-embedding-3-large) — configure it in settings.",
            )
        try:
            from geny_executor.memory.embedding.registry import (
                create_embedding_client,
            )
            from geny_executor.memory import QdrantVectorStore
        except ImportError as exc:
            raise KnowledgeUnavailable(
                "qdrant_unavailable",
                f"geny-executor knowledge surfaces unavailable: {exc}",
            ) from exc
        client = create_embedding_client(
            "openai", model=EMBEDDING_MODEL, api_key=key,
            dimension=EMBEDDING_DIM,
        )
        self._embedder = client
        self._store = QdrantVectorStore(
            url=_qdrant_url(),
            collection=_collection_for(self.username),
            client=client,
        )
        return self._store

    async def verify_embedding(self) -> None:
        """One embed round-trip validating the credential, cached per key
        value. Raises ``openai_key_invalid`` when the provider rejects the
        key; transient (non-auth) failures pass — the pipeline itself is
        best-effort and will surface them on the document card."""
        self._vector()  # raises openai_key_missing / qdrant_unavailable
        if self._embedder is None:
            return  # store injected directly (tests / custom wiring)
        key_id = hashlib.sha1(
            _resolve_openai_key().encode("utf-8"),
        ).hexdigest()
        state = _KEY_VALIDITY.get(key_id)
        if state is None:
            try:
                from geny_executor.memory.embedding.client import EmbeddingError
            except ImportError:
                return
            try:
                await self._embedder.embed(["ping"])
                _KEY_VALIDITY[key_id] = state = "ok"
            except EmbeddingError as exc:
                if exc.category != "auth":
                    return  # transient — don't cache, don't block
                _KEY_VALIDITY[key_id] = state = "auth"
        if state == "auth":
            raise KnowledgeUnavailable(
                "openai_key_invalid",
                "the configured OpenAI API key was rejected (401) — "
                "update it in settings.",
            )

    def status(self) -> Dict[str, Any]:
        key = _resolve_openai_key()
        key_state = (
            _KEY_VALIDITY.get(hashlib.sha1(key.encode("utf-8")).hexdigest())
            if key else None
        )
        return {
            "enabled": True,
            "embedding_model": EMBEDDING_MODEL,
            "embedding_ready": bool(key) and key_state != "auth",
            "embedding_key_state": key_state or ("unchecked" if key else "missing"),
            "qdrant_url": _qdrant_url(),
            "collection": _collection_for(self.username),
        }

    # ── ingestion ────────────────────────────────────────────────────

    async def ingest_file(
        self,
        *,
        filename: str,
        data: bytes,
        source_type: str = "upload",
        source_ref: str = "",
        doc_key: str = "",
    ) -> Dict[str, Any]:
        """Full pipeline for one document: attach original → card note
        (processing) → extract+chunk → embed+index → card ready/failed.
        Returns the card descriptor. Raises KnowledgeUnavailable for
        actionable config gaps BEFORE any side effect."""
        await self.verify_embedding()  # fail fast on missing/rejected key
        vector = self._vector()
        vault = self._vault()

        content_sha = hashlib.sha1(data).hexdigest()
        # Connectors pass a STABLE doc_key so re-fetches UPDATE the same
        # document (same card, replaced vectors); uploads default to the
        # content hash (identical file re-upload is a no-op identity).
        doc_id = (
            hashlib.sha1(doc_key.encode("utf-8")).hexdigest()[:12]
            if doc_key
            else content_sha[:12]
        )
        captured = datetime.now(timezone.utc)
        safe_name = Path(filename).name or f"document-{doc_id}"
        card_filename = f"doc-{doc_id}.md"

        # Incremental skip: unchanged content for a known document.
        existing = await self._vault().aread_note(
            f"{KNOWLEDGE_CATEGORY}/{card_filename}",
        )
        if existing is not None:
            prev = (existing.get("metadata") or {})
            if (
                prev.get("content_sha") == content_sha
                and prev.get("knowledge_status") == "ready"
            ):
                return {
                    "doc_id": doc_id, "filename": card_filename,
                    "title": safe_name, "status": "unchanged",
                    "chunks": prev.get("chunk_count", 0),
                }

        # 1) Original bytes into the vault's attachment area.
        attachment_rel = vault.save_attachment(
            data, suggested_name=f"knowledge-{doc_id}-{safe_name}",
        )

        # 2) Card note (status=processing) — visible in the UI immediately.
        await self._write_card(
            card_filename=card_filename,
            title=safe_name,
            doc_id=doc_id,
            attachment_rel=attachment_rel,
            source_type=source_type,
            source_ref=source_ref,
            status="processing",
            captured=captured,
            summary="",
            chunk_count=0,
            content_sha=content_sha,
        )

        # 3) Extract + chunk + index. Any failure lands on the card.
        try:
            chunks = self._extract_chunks(safe_name, data)
            if not chunks:
                raise RuntimeError("no extractable text")
            indexed = await self._index_chunks(
                vector, card_filename, doc_id, safe_name, source_type,
                source_ref, chunks,
            )
            preview = chunks[0]["text"][:400]
            await self._write_card(
                card_filename=card_filename,
                title=safe_name,
                doc_id=doc_id,
                attachment_rel=attachment_rel,
                source_type=source_type,
                source_ref=source_ref,
                status="ready",
                captured=captured,
                summary=preview,
                chunk_count=indexed,
                content_sha=content_sha,
            )
            return {
                "doc_id": doc_id, "filename": card_filename,
                "title": safe_name, "status": "ready", "chunks": indexed,
            }
        except Exception as exc:  # noqa: BLE001 — recorded on the card
            logger.warning("knowledge: ingest failed for %s", safe_name, exc_info=True)
            await self._write_card(
                card_filename=card_filename,
                title=safe_name,
                doc_id=doc_id,
                attachment_rel=attachment_rel,
                source_type=source_type,
                source_ref=source_ref,
                status="failed",
                captured=captured,
                summary=f"ingestion failed: {exc}",
                chunk_count=0,
                content_sha=content_sha,
            )
            return {
                "doc_id": doc_id, "filename": card_filename,
                "title": safe_name, "status": "failed", "error": str(exc),
            }

    async def ingest_text(
        self,
        *,
        title: str,
        text: str,
        source_type: str,
        source_ref: str = "",
        extension: str = "md",
        doc_key: str = "",
    ) -> Dict[str, Any]:
        """Connector-facing entry: ingest already-fetched text/payload.
        ``doc_key`` (e.g. source id + page url) makes re-fetches update
        the same document instead of accreting duplicates."""
        return await self.ingest_file(
            filename=f"{title}.{extension}",
            data=text.encode("utf-8"),
            source_type=source_type,
            source_ref=source_ref,
            doc_key=doc_key,
        )

    def _extract_chunks(self, filename: str, data: bytes) -> List[Dict[str, Any]]:
        try:
            from contextifier import DocumentProcessor
        except ImportError as exc:
            raise KnowledgeUnavailable(
                "contextifier_missing",
                "contextifier is not installed on the backend",
            ) from exc

        suffix = Path(filename).suffix or ".txt"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        try:
            result = DocumentProcessor().extract_chunks(
                tmp_path,
                chunk_size=_CHUNK_SIZE,
                chunk_overlap=_CHUNK_OVERLAP,
                include_position_metadata=True,
            )
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        rows: List[Dict[str, Any]] = []
        source = result.chunks_with_metadata or [
            type("C", (), {"text": t, "metadata": None}) for t in result.chunks
        ]
        for chunk in source[:_MAX_CHUNKS_PER_DOC]:
            text = (chunk.text or "").strip()
            if not text:
                continue
            meta = getattr(chunk, "metadata", None)
            rows.append({
                "text": text,
                "page": getattr(meta, "page_number", None) if meta else None,
                "heading": getattr(meta, "heading_path", None) if meta else None,
                "sheet": getattr(meta, "sheet_name", None) if meta else None,
            })
        return rows

    async def _index_chunks(
        self, vector, card_filename: str, doc_id: str, title: str,
        source_type: str, source_ref: str, rows: List[Dict[str, Any]],
    ) -> int:
        from geny_executor.memory import DocumentChunk
        from geny_executor.memory.provider import NoteRef, Scope

        chunks = []
        for row in rows:
            metadata: Dict[str, Any] = {
                "doc_id": doc_id,
                "title": title,
                "source_type": source_type,
                "source_ref": source_ref,
            }
            for key in ("page", "heading", "sheet"):
                if row.get(key) is not None:
                    metadata[key] = row[key]
            chunks.append(DocumentChunk(text=row["text"], metadata=metadata))
        ref = NoteRef(
            filename=card_filename, scope=Scope.USER, category=KNOWLEDGE_CATEGORY,
        )
        indexed = await vector.index_document(ref, chunks)
        if indexed == 0:
            raise RuntimeError("vector indexing failed (embedding/qdrant)")
        return indexed

    async def _write_card(
        self, *, card_filename: str, title: str, doc_id: str,
        attachment_rel: str, source_type: str, source_ref: str,
        status: str, captured, summary: str, chunk_count: int,
        content_sha: str = "",
    ) -> None:
        vault = self._vault()
        body = (
            f"![[{Path(attachment_rel).name}]]\n\n"
            + (f"{summary}\n\n" if summary else "")
            + f"- doc_id: {doc_id}\n"
            + f"- source: {source_type}{f' ({source_ref})' if source_ref else ''}\n"
            + f"- status: {status}\n"
            + f"- chunks: {chunk_count}\n"
            + f"- ingested_at: {captured.isoformat()}\n"
        )
        await vault.awrite_note(
            title=title,
            content=body,
            category=KNOWLEDGE_CATEGORY,
            tags=["knowledge", source_type],
            importance="medium",
            source=f"knowledge:{source_type}",
            filename_override=card_filename,
            frontmatter_extra={
                "doc_id": doc_id,
                "knowledge_status": status,
                "source_type": source_type,
                "source_ref": source_ref,
                "chunk_count": chunk_count,
                "attachment": attachment_rel,
                "content_sha": content_sha,
            },
        )

    # ── consumption ──────────────────────────────────────────────────

    async def search(self, query: str, *, top_k: int = 8) -> List[Dict[str, Any]]:
        await self.verify_embedding()  # a rejected key would read as "no results"
        vector = self._vector()
        hits = await vector.search(query, top_k=top_k)
        return [
            {
                "score": round(h.relevance_score, 4),
                "text": h.content,
                "doc_id": h.metadata.get("doc_id", ""),
                "title": h.metadata.get("title", ""),
                "page": h.metadata.get("page"),
                "heading": h.metadata.get("heading"),
                "source_type": h.metadata.get("source_type", ""),
                "filename": h.metadata.get("filename", ""),
            }
            for h in hits
        ]

    async def list_documents(self) -> List[Dict[str, Any]]:
        vault = self._vault()
        metas = await vault.alist_notes(category=KNOWLEDGE_CATEGORY)
        out = []
        for meta in metas[:500]:
            detail = await vault.aread_note(meta.get("filename", ""))
            fm = (detail or {}).get("metadata") or {}
            out.append({
                "filename": meta.get("filename"),
                "title": meta.get("title"),
                "doc_id": fm.get("doc_id", ""),
                "status": fm.get("knowledge_status", "ready"),
                "source_type": fm.get("source_type", ""),
                "source_ref": fm.get("source_ref", ""),
                "chunk_count": fm.get("chunk_count", 0),
                "modified": meta.get("modified", ""),
            })
        return out

    async def delete_document(self, doc_id: str) -> bool:
        """Card note + original attachment + qdrant points."""
        from geny_executor.memory.provider import NoteRef, Scope

        vault = self._vault()
        card_filename = f"doc-{doc_id}.md"
        note = await vault.aread_note(f"{KNOWLEDGE_CATEGORY}/{card_filename}")
        attachment = ((note or {}).get("metadata") or {}).get("attachment", "")
        try:
            await self._vector().remove(
                NoteRef(filename=card_filename, scope=Scope.USER),
            )
        except KnowledgeUnavailable:
            pass  # no embedding key → nothing was ever indexed
        if attachment:
            try:
                vault.delete_attachment(attachment)
            except Exception:  # noqa: BLE001
                pass
        return await vault.adelete_note(card_filename)


_services: Dict[str, KnowledgeService] = {}


def get_knowledge_service(username: str) -> KnowledgeService:
    svc = _services.get(username)
    if svc is None:
        svc = KnowledgeService(username)
        _services[username] = svc
    return svc
