"""KnowledgeService — the user vault as a knowledge repository.

Design (2026-07 knowledge-repository plan):

* **The user vault IS the knowledge space.** Uploaded documents keep their
  original bytes in the vault's ``_attachments/`` area and appear as a
  "document card" note in the ``knowledge`` category — so the sidebar,
  graph, keyword search, and the Opsidian UI all see them like any other
  note. Auto-collected content (connectors) lands the same way.
* **Contextifier converts, executor embeds, qdrant serves.** Extraction +
  chunking is `contextifier` (`extract_chunks` with position metadata:
  page/heading/sheet per chunk); the embedding provider/model comes from
  the Model & Provider panel's Embedding card (``embedding_settings``);
  vectors live in a per-(user, model) qdrant collection via the
  executor's ``QdrantVectorStore``. Each document card records the model
  that embedded it — a mismatch with the current setting marks the doc
  ``embedding_stale`` and ``reembed_document`` repairs it from the
  stored original bytes.
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
import re
import tempfile
from datetime import datetime, timezone
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)

KNOWLEDGE_CATEGORY = "knowledge"
_CHUNK_SIZE = 1200
_CHUNK_OVERLAP = 150
_MAX_CHUNKS_PER_DOC = 2000
# Every chunk we embed must fit the embedding model's token budget (8192
# for OpenAI text-embedding-*). A token never exceeds the UTF-8 byte count,
# so keeping each chunk under this byte cap guarantees it never trips the
# provider's limit. Contextifier normally yields ~1200-char chunks, well
# under this — but a table / protected region / structure-aware JSON line
# can be larger, so we hard-split anything over the cap as defense in depth.
_MAX_CHUNK_BYTES = 7000


def _byte_safe_chunks(text: str, limit: int = _MAX_CHUNK_BYTES) -> List[str]:
    """Split ``text`` so each piece's UTF-8 encoding is ≤ ``limit`` bytes,
    preferring line boundaries and hard-cutting any single oversized line
    on a UTF-8 char boundary. A no-op for already-small text."""
    if len(text.encode("utf-8")) <= limit:
        return [text]
    out: List[str] = []
    buf = ""

    def _flush() -> None:
        nonlocal buf
        if buf.strip():
            out.append(buf.strip())
        buf = ""

    for line in text.splitlines(keepends=True):
        if buf and len((buf + line).encode("utf-8")) > limit:
            _flush()
        if len(line.encode("utf-8")) > limit:
            encoded = line.encode("utf-8")
            for i in range(0, len(encoded), limit):
                piece = encoded[i : i + limit].decode("utf-8", errors="ignore")
                if piece.strip():
                    out.append(piece.strip())
            continue
        buf += line
    _flush()
    return [p for p in out if p] or [text[: limit // 2]]


#: Pseudo-model name for the local Synapse knowledge backend. Used as the
#: collection/db-file slug and recorded on document cards as embedding_model.
_SYNAPSE_KB_MODEL = "synapse-hash-static"


def _memory_engine() -> str:
    """Configured memory engine ("synapse" default, or "composite"). Decides
    whether the knowledge repo runs on the local Synapse backend (zero API) or
    the qdrant + API-embedding backend."""
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.ltm_config import LTMConfig

        ltm = get_config_manager().load_config(LTMConfig) or LTMConfig.get_default_instance()
        return (getattr(ltm, "memory_engine", "synapse") or "synapse").strip()
    except Exception:  # noqa: BLE001
        return "synapse"


def _synapse_dim() -> int:
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.ltm_config import LTMConfig

        ltm = get_config_manager().load_config(LTMConfig) or LTMConfig.get_default_instance()
        return int(getattr(ltm, "synapse_dim", 256) or 256)
    except Exception:  # noqa: BLE001
        return 256


def _embedding_spec() -> "tuple[str, str, int]":
    """(provider, model, dimension). Under the synapse engine this is the local
    engine's fixed spec (no API); otherwise it's the Model & Provider panel's
    Embedding card (``embedding_settings``), normalised against the registry."""
    if _memory_engine() == "synapse":
        return ("synapse", _SYNAPSE_KB_MODEL, _synapse_dim())

    from service.config.sub_config.general.embedding_config import (
        DEFAULT_EMBEDDING_MODEL,
        DEFAULT_EMBEDDING_PROVIDER,
        EmbeddingSettingsConfig,
        resolve_embedding_spec,
    )

    provider, model = DEFAULT_EMBEDDING_PROVIDER, DEFAULT_EMBEDDING_MODEL
    try:
        from service.config.manager import get_config_manager

        cfg = get_config_manager().load_config(EmbeddingSettingsConfig)
        provider, model = cfg.provider, cfg.model
    except Exception:  # noqa: BLE001 — config layer down → defaults
        pass
    return resolve_embedding_spec(provider, model)


class KnowledgeUnavailable(RuntimeError):
    """Knowledge repo can't operate; ``reason`` is machine-readable
    (``openai_key_missing`` | ``qdrant_unavailable`` | ``contextifier_missing``)."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def _qdrant_url() -> str:
    return os.environ.get("GENY_QDRANT_URL", "http://qdrant:6333")


def _resolve_embedding_key(provider: str) -> str:
    """Embedding key: LTM ``embedding_api_key`` if the user deliberately
    set a separate embedding key, else the central Model & Provider key
    for the configured embedding provider."""
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.ltm_config import LTMConfig

        ltm = get_config_manager().load_config(LTMConfig)
        key = (getattr(ltm, "embedding_api_key", "") or "").strip()
        if key:
            return key
    except Exception:  # noqa: BLE001
        pass
    try:
        from service.config.credentials import resolve_provider_key

        return resolve_provider_key(provider)
    except Exception:  # noqa: BLE001
        env_var = {"openai": "OPENAI_API_KEY", "google": "GOOGLE_API_KEY"}.get(
            provider, "OPENAI_API_KEY",
        )
        return (os.environ.get(env_var) or "").strip()


def _collection_for(username: str, model: str) -> str:
    """Per-(user, embedding-model) qdrant collection. A model switch gets
    a FRESH collection — vector dimensions differ between models, and
    re-embedded documents move over one by one instead of a destructive
    drop-and-recreate of a shared collection."""
    safe = "".join(c if c.isalnum() else "_" for c in username.lower())
    model_slug = "".join(c if c.isalnum() else "_" for c in model.lower())
    return f"geny_kb__{safe or 'anonymous'}__{model_slug}"


def _knowledge_db_path(username: str, model: str) -> str:
    """Local Synapse db file for a (user, model) knowledge collection — the
    single-file analog of a qdrant collection. Per-user isolation = per-file."""
    from service.utils.platform import DEFAULT_STORAGE_ROOT

    return os.path.join(DEFAULT_STORAGE_ROOT, "_knowledge_kb",
                        _collection_for(username, model) + ".db")


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
        # (key sha, provider, model) the cached store was built with —
        # any change rebuilds it.
        self._built_with = None

    # ── wiring ───────────────────────────────────────────────────────

    def _vault(self):
        from service.memory.user_opsidian import get_user_opsidian_manager

        return get_user_opsidian_manager(self.username)

    def _vector(self):
        provider, model, dim = _embedding_spec()

        # Synapse engine: a local, zero-API document store. No key, no qdrant.
        if provider == "synapse":
            build_id = ("synapse", model, dim)
            if self._store is not None and self._built_with == build_id:
                return self._store
            from service.knowledge.synapse_store import (
                build_knowledge_synapse_store,
            )

            store = build_knowledge_synapse_store(
                db_path=_knowledge_db_path(self.username, model),
                dim=dim, model=model)
            if store is None:
                raise KnowledgeUnavailable(
                    "qdrant_unavailable",
                    "geny-memory-adaptor is not installed — the local "
                    "knowledge engine is unavailable.",
                )
            self._store = store
            self._embedder = None  # synapse embeds internally → verify passes
            self._built_with = build_id
            return self._store

        key = _resolve_embedding_key(provider)
        key_sha = hashlib.sha1(key.encode("utf-8")).hexdigest() if key else None
        build_id = (key_sha, provider, model)
        if self._store is not None:
            # An injected store (tests / custom wiring) has no build id —
            # keep it. A self-built store is only valid while the resolved
            # key AND the embedding spec are unchanged: after a rotation
            # the old embedder would ping with the RETIRED key and poison
            # the new key's validity verdict; after a model switch it
            # would index into the wrong collection at the wrong
            # dimension.
            if self._built_with is None or self._built_with == build_id:
                return self._store
            self._store = None
            self._embedder = None
            self._built_with = None
        if not key:
            raise KnowledgeUnavailable(
                "openai_key_missing",
                f"{provider} API key is required for knowledge embeddings "
                f"({model}) — configure it in the Model & Provider settings.",
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
            provider, model=model, api_key=key, dimension=dim,
        )
        self._embedder = client
        self._store = QdrantVectorStore(
            url=_qdrant_url(),
            collection=_collection_for(self.username, model),
            client=client,
        )
        self._built_with = build_id
        return self._store

    def _store_for_model(self, model: str):
        """A QdrantVectorStore bound to *model*'s collection — used to
        remove vectors of documents embedded under a previous model. The
        current embedder is reused: removal never embeds."""
        provider, current_model, _ = _embedding_spec()
        # Synapse is single-model + single-file per user, so there is never a
        # cross-model store to reach — the current vector store is authoritative.
        if provider == "synapse" or model == current_model:
            return self._vector()
        vector = self._vector()  # ensures self._embedder exists
        try:
            from geny_executor.memory import QdrantVectorStore
        except ImportError:
            return vector
        return QdrantVectorStore(
            url=_qdrant_url(),
            collection=_collection_for(self.username, model),
            client=self._embedder,
        )

    async def verify_embedding(self) -> None:
        """One embed round-trip validating the credential, cached per key
        value. Raises ``openai_key_invalid`` when the provider rejects the
        key; transient (non-auth) failures pass — the pipeline itself is
        best-effort and will surface them on the document card."""
        self._vector()  # raises openai_key_missing / qdrant_unavailable
        if self._embedder is None:
            return  # store injected directly (tests / custom wiring)
        provider, _, _ = _embedding_spec()
        key_id = hashlib.sha1(
            _resolve_embedding_key(provider).encode("utf-8"),
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
                f"the configured {provider} API key was rejected (401) — "
                "update it in the Model & Provider settings.",
            )

    def status(self) -> Dict[str, Any]:
        provider, model, dim = _embedding_spec()
        if provider == "synapse":
            # Local engine: always ready, no key, no qdrant.
            return {
                "enabled": True,
                "embedding_provider": "synapse",
                "embedding_model": model,
                "embedding_dim": dim,
                "embedding_ready": True,
                "embedding_key_state": "local",
                "qdrant_url": "",
                "collection": _collection_for(self.username, model),
            }
        key = _resolve_embedding_key(provider)
        key_state = (
            _KEY_VALIDITY.get(hashlib.sha1(key.encode("utf-8")).hexdigest())
            if key else None
        )
        return {
            "enabled": True,
            "embedding_provider": provider,
            "embedding_model": model,
            "embedding_dim": dim,
            "embedding_ready": bool(key) and key_state != "auth",
            "embedding_key_state": key_state or ("unchecked" if key else "missing"),
            "qdrant_url": _qdrant_url(),
            "collection": _collection_for(self.username, model),
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

        # Incremental skip: unchanged content for a known document —
        # but only while its recorded embedding model is still current;
        # a stale doc re-fetched by a connector re-embeds itself.
        _, current_model, _ = _embedding_spec()
        existing = await self._vault().aread_note(
            f"{KNOWLEDGE_CATEGORY}/{card_filename}",
        )
        if existing is not None:
            prev = (existing.get("metadata") or {})
            if (
                prev.get("content_sha") == content_sha
                and prev.get("knowledge_status") == "ready"
                and prev.get("embedding_model", current_model) == current_model
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
            original_filename=safe_name,
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
                original_filename=safe_name,
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
                original_filename=safe_name,
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
            page = getattr(meta, "page_number", None) if meta else None
            heading = getattr(meta, "heading_path", None) if meta else None
            sheet = getattr(meta, "sheet_name", None) if meta else None
            # Guarantee every chunk fits the embedding token budget — a
            # single Contextifier chunk (big table / protected block) can
            # exceed it; split those so embedding never 400s.
            for piece in _byte_safe_chunks(text):
                rows.append({
                    "text": piece, "page": page,
                    "heading": heading, "sheet": sheet,
                })
                if len(rows) >= _MAX_CHUNKS_PER_DOC:
                    break
            if len(rows) >= _MAX_CHUNKS_PER_DOC:
                break
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
        content_sha: str = "", original_filename: str = "",
    ) -> None:
        vault = self._vault()
        provider, model, _ = _embedding_spec()
        # The clean human filename (Unicode preserved), independent of the
        # on-disk attachment name — this is what re-embedding restores as
        # the title and what downloads name the file.
        original_filename = original_filename or title
        body = (
            f"![[{Path(attachment_rel).name}]]\n\n"
            + (f"{summary}\n\n" if summary else "")
            + f"- doc_id: {doc_id}\n"
            + f"- source: {source_type}{f' ({source_ref})' if source_ref else ''}\n"
            + f"- status: {status}\n"
            + f"- chunks: {chunk_count}\n"
            + f"- embedding: {provider}/{model}\n"
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
                "original_filename": original_filename,
                # Exactly which model produced this document's vectors —
                # the mismatch signal that drives re-embedding.
                "embedding_provider": provider,
                "embedding_model": model,
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

    async def index_note(self, *, filename: str, title: str, text: str) -> int:
        """Embed a user-created vault note into the knowledge index so the
        agent's ``opsidian_search`` finds it semantically — the SAME
        treatment uploads and connectors get, keeping all three supply
        paths consistent. Keyed by the note's real vault path (no doc
        card — the note IS its own record). Best-effort: returns 0 and
        stays silent when embedding isn't configured, so note creation
        never fails on a missing key. Managed document cards
        (``doc-<id>.md``) are skipped (ingest_file already indexed them)."""
        leaf = filename.replace("\\", "/").split("/")[-1]
        if re.match(r"^doc-[0-9a-f]{6,}\.md$", leaf):
            return 0
        try:
            vector = self._vector()
        except KnowledgeUnavailable:
            return 0  # embedding not ready — note stays markdown-only
        text = (text or "").strip()
        if not text:
            await self.remove_note(filename)
            return 0
        try:
            rows = self._extract_chunks(leaf, text.encode("utf-8"))
        except Exception:  # noqa: BLE001 — Contextifier failed; chunk it ourselves
            rows = [{"text": p} for p in _byte_safe_chunks(text)]
        if not rows:
            await self.remove_note(filename)
            return 0
        try:
            return await self._index_chunks(
                vector, filename, "", title or leaf, "note", "", rows,
            )
        except Exception:  # noqa: BLE001 — best-effort; note is already saved
            logger.info("knowledge: note index skipped for %s", filename, exc_info=True)
            return 0

    async def remove_note(self, filename: str) -> bool:
        """Drop a note's vectors from the current-model collection (called
        on note delete / when a note is emptied)."""
        from geny_executor.memory.provider import NoteRef, Scope

        try:
            vector = self._vector()
        except KnowledgeUnavailable:
            return False
        try:
            return await vector.remove(NoteRef(filename=filename, scope=Scope.USER))
        except Exception:  # noqa: BLE001
            return False

    async def list_documents(self) -> List[Dict[str, Any]]:
        _, current_model, _ = _embedding_spec()
        vault = self._vault()
        metas = await vault.alist_notes(category=KNOWLEDGE_CATEGORY)
        out = []
        for meta in metas[:500]:
            detail = await vault.aread_note(meta.get("filename", ""))
            fm = (detail or {}).get("metadata") or {}
            # Docs from before model recording carry no embedding_model —
            # treat them as embedded with the launch default.
            doc_model = fm.get("embedding_model") or "text-embedding-3-large"
            original_filename = fm.get("original_filename") or meta.get("title")
            out.append({
                "filename": meta.get("filename"),
                "title": original_filename or meta.get("title"),
                "original_filename": original_filename,
                "attachment": fm.get("attachment", ""),
                "doc_id": fm.get("doc_id", ""),
                "status": fm.get("knowledge_status", "ready"),
                "source_type": fm.get("source_type", ""),
                "source_ref": fm.get("source_ref", ""),
                "chunk_count": fm.get("chunk_count", 0),
                "modified": meta.get("modified", ""),
                "embedding_provider": fm.get("embedding_provider", ""),
                "embedding_model": doc_model,
                # Mismatch with the CURRENT embedding model → its vectors
                # live in another collection and no longer serve search.
                "embedding_stale": doc_model != current_model,
            })
        return out

    async def get_document_chunks(self, doc_id: str) -> Dict[str, Any]:
        """Every stored chunk of a document, ordered by chunk_index, each
        with its full text + page/heading provenance. Reads from the
        collection the doc was actually embedded into (so a stale doc is
        still viewable). Powers the chunk viewer and the document-read
        tool's reassembly."""
        from geny_executor.memory.provider import NoteRef, Scope

        vault = self._vault()
        card_filename = f"doc-{doc_id}.md"
        note = await vault.aread_note(f"{KNOWLEDGE_CATEGORY}/{card_filename}")
        if note is None:
            raise KeyError(f"document not found: {doc_id}")
        fm = (note.get("metadata") or {})
        doc_model = fm.get("embedding_model") or ""
        store = self._store_for_model(doc_model) if doc_model else self._vector()

        fetch = getattr(store, "fetch_document", None)
        chunks: List[Dict[str, Any]] = []
        if callable(fetch):
            for mc in await fetch(NoteRef(filename=card_filename, scope=Scope.USER)):
                meta = mc.metadata or {}
                chunks.append({
                    "chunk_index": meta.get("chunk_index", 0),
                    "text": mc.content,
                    "page": meta.get("page"),
                    "heading": meta.get("heading"),
                    "sheet": meta.get("sheet"),
                })
        return {
            "doc_id": doc_id,
            "title": fm.get("original_filename") or note.get("title") or doc_id,
            "embedding_model": doc_model,
            "chunk_count": fm.get("chunk_count", len(chunks)),
            "chunks": chunks,
        }

    async def get_document_text(self, doc_id: str) -> Dict[str, Any]:
        """The reassembled full text of a document (ordered chunks joined),
        with light page markers. This is what the document-read tool
        returns to an agent."""
        detail = await self.get_document_chunks(doc_id)
        parts: List[str] = []
        last_page = None
        for ch in detail["chunks"]:
            page = ch.get("page")
            if page is not None and page != last_page:
                parts.append(f"\n[Page {page}]")
                last_page = page
            parts.append(ch["text"])
        return {
            "doc_id": doc_id,
            "title": detail["title"],
            "chunk_count": detail["chunk_count"],
            "text": "\n\n".join(p for p in parts if p).strip(),
        }

    async def reembed_document(self, doc_id: str) -> Dict[str, Any]:
        """Re-run extract+embed+index for one document from its stored
        original bytes, under the CURRENT embedding model — the repair
        action for embedding-model mismatches."""
        await self.verify_embedding()
        vault = self._vault()
        card_filename = f"doc-{doc_id}.md"
        note = await vault.aread_note(f"{KNOWLEDGE_CATEGORY}/{card_filename}")
        if note is None:
            raise KeyError(f"document not found: {doc_id}")
        fm = (note.get("metadata") or {})
        attachment = fm.get("attachment", "")
        data = vault.read_attachment(attachment) if attachment else None
        if not data:
            raise RuntimeError(
                f"original attachment missing for {doc_id} — re-upload the file",
            )

        # Drop the old-model vectors so nothing orphans, then ingest the
        # stored bytes through the normal pipeline (current model records
        # itself on the card; content unchanged → same doc identity).
        old_model = fm.get("embedding_model") or ""
        _, current_model, _ = _embedding_spec()
        if old_model and old_model != current_model:
            try:
                from geny_executor.memory.provider import NoteRef, Scope

                await self._store_for_model(old_model).remove(
                    NoteRef(filename=card_filename, scope=Scope.USER),
                )
            except Exception:  # noqa: BLE001 — old vectors are harmless
                logger.info("reembed: old-model vector cleanup skipped", exc_info=True)

        # Preserve the clean human filename across re-embedding. Prefer the
        # stored original_filename; fall back to the card title, then to the
        # attachment name with the "knowledge-<doc_id>-" prefix stripped.
        attachment_leaf = Path(attachment).name
        stripped = attachment_leaf
        prefix = f"knowledge-{doc_id}-"
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix):]
        display_name = (
            fm.get("original_filename")
            or note.get("title")
            or stripped
            or f"document-{doc_id}"
        )
        return await self._reingest_existing(
            doc_id=doc_id,
            card_filename=card_filename,
            display_name=display_name,
            extract_name=stripped or display_name,  # extension for extraction
            data=data,
            fm=fm,
        )

    async def _reingest_existing(
        self, *, doc_id: str, card_filename: str, display_name: str,
        extract_name: str, data: bytes, fm: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Ingest pipeline for an EXISTING card — keeps the doc_id even
        when it originally came from a connector doc_key (whose sha the
        content hash can't reproduce), and preserves the human filename
        (``display_name``) as the title/original_filename."""
        vector = self._vector()
        captured = datetime.now(timezone.utc)
        source_type = fm.get("source_type") or "upload"
        source_ref = fm.get("source_ref", "")
        attachment_rel = fm.get("attachment", "")
        content_sha = hashlib.sha1(data).hexdigest()
        common = dict(
            card_filename=card_filename, title=display_name, doc_id=doc_id,
            attachment_rel=attachment_rel, source_type=source_type,
            source_ref=source_ref, captured=captured, content_sha=content_sha,
            original_filename=display_name,
        )
        try:
            chunks = self._extract_chunks(extract_name, data)
            if not chunks:
                raise RuntimeError("no extractable text")
            indexed = await self._index_chunks(
                vector, card_filename, doc_id, display_name, source_type,
                source_ref, chunks,
            )
            await self._write_card(
                status="ready", summary=chunks[0]["text"][:400],
                chunk_count=indexed, **common,
            )
            return {
                "doc_id": doc_id, "filename": card_filename,
                "title": display_name, "status": "ready", "chunks": indexed,
            }
        except Exception as exc:  # noqa: BLE001 — recorded on the card
            logger.warning("knowledge: reembed failed for %s", doc_id, exc_info=True)
            await self._write_card(
                status="failed", summary=f"re-embedding failed: {exc}",
                chunk_count=0, **common,
            )
            return {
                "doc_id": doc_id, "filename": card_filename,
                "title": display_name, "status": "failed", "error": str(exc),
            }

    async def delete_document(self, doc_id: str) -> bool:
        """Card note + original attachment + qdrant points (removed from
        the collection of the model the doc was actually embedded with)."""
        from geny_executor.memory.provider import NoteRef, Scope

        vault = self._vault()
        card_filename = f"doc-{doc_id}.md"
        note = await vault.aread_note(f"{KNOWLEDGE_CATEGORY}/{card_filename}")
        fm = ((note or {}).get("metadata") or {})
        attachment = fm.get("attachment", "")
        doc_model = fm.get("embedding_model") or ""
        try:
            store = (
                self._store_for_model(doc_model) if doc_model else self._vector()
            )
            await store.remove(
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
