"""
Curated Knowledge Manager — Refined knowledge layer between User Opsidian and Agent.

The Curated Knowledge scope acts as a quality-controlled bridge:
- Notes are 100% compatible with the existing Opsidian format
  (YAML frontmatter + structured Markdown)
- Adds optional FAISS vector search for semantic retrieval (when
  ``LTMConfig.curated_vector_enabled`` is on)
- Notes originate from User Opsidian (via curation) or agent promotions

Storage layout::

    {STORAGE_ROOT}/_curated_knowledge/{username}/
        topics/
        decisions/
        insights/
        projects/
        reference/
        _index.json
        _vector/               (FAISS index, when vector search is enabled)

Each user gets their own single-tenant ``MemoryProvider`` (file-backed,
scope=user). When ``curated_vector_enabled`` is set, the provider's
embedding hook auto-indexes every note write so vector search picks
up new content without an explicit reindex pass.
"""

from __future__ import annotations

import os
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)


class CuratedKnowledgeManager:
    """Per-user curated knowledge vault with Obsidian-like notes + optional vector search.

    Each user gets an isolated directory under ``_curated_knowledge/{username}/``
    backed by a dedicated single-tenant ``MemoryProvider``.
    """

    def __init__(self, username: str, base_path: Optional[str] = None):
        if base_path is None:
            base_path = self._default_path()
        self.username = username
        self.memory_dir = os.path.join(base_path, "_curated_knowledge", username)
        os.makedirs(self.memory_dir, exist_ok=True)

        self._provider: Optional[Any] = None
        self._initialized = False
        self._vector_enabled = False
        self._initialize()

    @staticmethod
    def _default_path() -> str:
        """N.1 (cycle 20260426_3) — settings.json:curated_knowledge.root
        wins; falls back to ``DEFAULT_STORAGE_ROOT`` from the platform
        helper."""
        try:
            from geny_executor.settings import get_default_loader

            section = get_default_loader().get_section("curated_knowledge")
            if section is not None:
                if hasattr(section, "model_dump"):
                    section_dict = section.model_dump(exclude_none=True)
                elif isinstance(section, dict):
                    section_dict = section
                else:
                    section_dict = {}
                root = section_dict.get("root")
                if isinstance(root, str) and root.strip():
                    return root.strip()
        except Exception:  # noqa: BLE001
            pass
        from service.utils.platform import DEFAULT_STORAGE_ROOT
        return DEFAULT_STORAGE_ROOT

    def _initialize(self):
        """Build the per-user single-tenant `MemoryProvider`."""
        try:
            from service.memory.provider_bridge import build_single_tenant_provider
            from service.memory.sync_async_bridge import run_coro_sync

            # Read curated_vector_enabled to decide whether the
            # embedding plane attaches. When the flag is off the
            # provider stays markdown-only — list/read/write still
            # work but ``provider.vector()`` returns None.
            enable_embedding = False
            try:
                from service.config import get_config_manager
                from service.config.sub_config.general.ltm_config import LTMConfig

                cfg_mgr = get_config_manager()
                ltm = cfg_mgr.load_config(LTMConfig) or LTMConfig.get_default_instance()
                enable_embedding = bool(getattr(ltm, "curated_vector_enabled", False))
            except Exception:  # noqa: BLE001
                ltm = None

            self._provider = run_coro_sync(
                build_single_tenant_provider(
                    root=self.memory_dir,
                    scope_id=f"curated:{self.username}",
                    scope="user",
                    enable_embedding=enable_embedding,
                    ltm_config=ltm if enable_embedding else None,
                )
            )
            try:
                self._vector_enabled = self._provider.vector() is not None
            except Exception:  # noqa: BLE001
                self._vector_enabled = False
            self._initialized = True

            logger.info(
                "CuratedKnowledgeManager initialized for '%s' at %s "
                "(vector=%s)",
                self.username, self.memory_dir, self._vector_enabled,
            )
        except Exception:
            logger.warning(
                "CuratedKnowledgeManager: init failed for '%s' (non-critical)",
                self.username, exc_info=True,
            )

    async def initialize_vector(self) -> bool:
        """Compatibility shim — vector layer is provisioned at provider
        build time when ``curated_vector_enabled`` is set. This method
        kept as a no-op for callers that historically gated vector use
        on its return value.
        """
        return self._vector_enabled

    # ── Properties ────────────────────────────────────────────────────

    @property
    def initialized(self) -> bool:
        return self._initialized

    @property
    def vector_enabled(self) -> bool:
        return self._vector_enabled

    # ── Read Operations ───────────────────────────────────────────────

    def list_notes(
        self,
        *,
        category: Optional[str] = None,
        tag: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        if self._provider is None:
            return []
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            metas = run_coro_sync(
                self._provider.notes().list(category=category, tag=tag)
            )
        except Exception:
            logger.debug(
                "CuratedKnowledgeManager.list_notes: failed", exc_info=True,
            )
            return []
        return [self._meta_to_dict(m) for m in metas]

    @staticmethod
    def _meta_to_dict(meta) -> Dict[str, Any]:
        cat = meta.category or "root"
        bare = meta.ref.filename
        display_filename = bare if cat == "root" else f"{cat}/{bare}"
        return {
            "filename": display_filename,
            "title": meta.title or bare,
            "category": cat,
            "tags": list(meta.tags),
            "importance": meta.importance.value,
            "created": meta.created_at.isoformat() if meta.created_at else "",
            "modified": meta.updated_at.isoformat() if meta.updated_at else "",
            "source": "curated",
            "char_count": meta.size_bytes,
            "links_to": [],
            "linked_from": [],
            "summary": None,
        }

    def read_note(self, filename: str) -> Optional[Dict[str, Any]]:
        if self._provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        bare = Path(filename).name
        try:
            note = run_coro_sync(self._provider.notes().read(bare))
        except Exception:
            return None
        if note is None:
            return None
        metadata = {
            "title": note.title,
            "tags": list(note.tags),
            "category": note.category,
            "importance": note.importance.value,
            "links_to": list(note.links_out),
            "linked_from": list(note.links_in),
            **(note.frontmatter or {}),
        }
        return {
            "filename": filename,
            "title": note.title,
            "metadata": metadata,
            "body": note.body,
            "raw": "",
            "links_to": list(note.links_out),
            "linked_from": list(note.links_in),
        }

    def search(self, query: str, max_results: int = 10) -> List[Dict[str, Any]]:
        """Keyword search across curated notes."""
        if self._provider is None:
            return []
        all_notes = self.list_notes()
        query_lower = query.lower()
        results = []
        for note_info in all_notes:
            fn = note_info["filename"]
            note = self.read_note(fn)
            if note is None:
                continue
            body = (note.get("body") or "").lower()
            title = (note.get("metadata", {}).get("title") or "").lower()
            tags = note.get("metadata", {}).get("tags") or []
            importance = note.get("metadata", {}).get("importance", "medium")
            score = 0.0
            if query_lower in title:
                score += 2.0
            if query_lower in body:
                score += 1.0
            for tag in tags:
                if query_lower in tag.lower():
                    score += 0.5
            # Boost by importance
            importance_boost = {
                "critical": 2.0, "high": 1.5, "medium": 1.0, "low": 0.5,
            }
            score *= importance_boost.get(importance, 1.0)
            if score > 0:
                results.append({
                    **note_info,
                    "score": score,
                    "snippet": (note.get("body") or "")[:300],
                })
        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:max_results]

    async def vector_search(
        self,
        query: str,
        *,
        top_k: int = 5,
        score_threshold: float = 0.35,
    ) -> List[Dict[str, Any]]:
        """Semantic vector search across curated notes.

        Requires ``curated_vector_enabled`` in LTMConfig at provider
        build time. Falls back to empty list when the vector handle
        is unavailable.
        """
        if self._provider is None or not self._vector_enabled:
            return []
        vector = self._provider.vector()
        if vector is None:
            return []
        try:
            chunks = await vector.search(
                query, top_k=top_k, threshold=score_threshold,
            )
        except Exception:
            logger.debug(
                "CuratedKnowledgeManager.vector_search: provider failed",
                exc_info=True,
            )
            return []
        return [
            {
                "source_file": (c.metadata.get("filename") or c.key) if c.metadata else c.key,
                "text": c.content,
                "score": c.relevance_score,
                "chunk_index": int(c.metadata.get("chunk_index", 0)) if c.metadata else 0,
            }
            for c in chunks
        ]

    def get_index(self) -> Optional[Dict[str, Any]]:
        if self._provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            payload = run_coro_sync(self._provider.index().snapshot())
        except Exception:
            logger.debug(
                "CuratedKnowledgeManager.get_index: failed", exc_info=True,
            )
            return None
        files = payload.get("files") or {}
        return {
            "files": {
                k: {
                    "filename": v.get("filename", k),
                    "title": v.get("title", ""),
                    "category": v.get("category", "root"),
                    "tags": v.get("tags", []),
                    "importance": v.get("importance", "medium"),
                    "char_count": v.get("char_count", 0),
                    "links_to": v.get("links_to", []),
                    "linked_from": v.get("linked_from", []),
                    "summary": v.get("summary"),
                }
                for k, v in files.items()
            },
            "tag_map": payload.get("tag_map", {}),
            "total_files": int(payload.get("total_files", len(files)) or len(files)),
            "total_chars": int(payload.get("total_chars", 0) or 0),
        }

    def get_stats(self) -> Dict[str, Any]:
        idx = self.get_index()
        if idx is None:
            return {
                "total_files": 0, "total_chars": 0,
                "categories": {}, "total_tags": 0,
                "vector_enabled": self.vector_enabled,
            }
        categories: Dict[str, int] = {}
        for info in (idx.get("files") or {}).values():
            cat = info.get("category", "unknown")
            categories[cat] = categories.get(cat, 0) + 1
        return {
            "total_files": idx.get("total_files", 0),
            "total_chars": idx.get("total_chars", 0),
            "categories": categories,
            "total_tags": len(idx.get("tag_map", {})),
            "vector_enabled": self.vector_enabled,
        }

    def get_graph(self) -> Dict[str, Any]:
        """Get graph data for visualization (enhanced with tag edges + metadata)."""
        idx = self.get_index()
        if idx is None:
            return {"nodes": [], "edges": []}
        nodes = []
        edges = []
        edge_set: set = set()
        tag_to_files: Dict[str, List[str]] = {}
        files_map = idx.get("files", {})

        for fn, info in files_map.items():
            links_to = info.get("links_to", [])
            linked_from = info.get("linked_from", [])
            tags = info.get("tags", [])

            nodes.append({
                "id": fn,
                "label": info.get("title", fn),
                "category": info.get("category", "root"),
                "importance": info.get("importance", "medium"),
                "tags": tags,
                "connectionCount": len(links_to) + len(linked_from),
                "summary": info.get("summary", ""),
                "charCount": info.get("char_count", 0),
            })

            # Wikilink edges
            for target in links_to:
                if target in files_map:
                    key = (fn, target)
                    if key not in edge_set:
                        edge_set.add(key)
                        edges.append({
                            "source": fn,
                            "target": target,
                            "type": "wikilink",
                            "weight": 1.0,
                        })

            # Build tag map
            for tag in tags:
                tag_to_files.setdefault(tag, []).append(fn)

        # Tag-based edges
        for tag, fns in tag_to_files.items():
            if len(fns) < 2:
                continue
            for i in range(len(fns)):
                for j in range(i + 1, len(fns)):
                    a, b = fns[i], fns[j]
                    if (a, b) not in edge_set and (b, a) not in edge_set:
                        edge_set.add((a, b))
                        edges.append({
                            "source": a,
                            "target": b,
                            "type": "tag",
                            "weight": 0.5,
                            "label": tag,
                        })

        return {"nodes": nodes, "edges": edges}

    # ── Write Operations ──────────────────────────────────────────────

    def write_note(
        self,
        title: str,
        content: str,
        *,
        category: str = "topics",
        tags: Optional[List[str]] = None,
        importance: str = "medium",
        source: str = "curated",
        links_to: Optional[List[str]] = None,
        source_filename: Optional[str] = None,
    ) -> Optional[str]:
        """Create a curated note via ``provider.notes().write``."""
        if self._provider is None:
            return None
        from geny_executor.memory.provider import (
            Importance as _ExecutorImportance,
            NoteDraft,
            Scope,
        )
        from service.memory.note_utils import (
            VALID_CATEGORIES,
            _slugify,
            extract_wikilinks,
        )
        from service.memory.sync_async_bridge import run_coro_sync

        # Add source tracking tags
        all_tags = list(tags or [])
        if source and f"source:{source}" not in all_tags:
            all_tags.append(f"source:{source}")
        if source_filename:
            all_tags.append(f"origin:{source_filename}")

        cat = category if category in VALID_CATEGORIES else "topics"
        tag_list = [t.lower().strip() for t in all_tags if t.strip()]
        auto_links = extract_wikilinks(content)
        all_links = list(set(auto_links + (links_to or [])))

        try:
            importance_enum = _ExecutorImportance(importance)
        except ValueError:
            importance_enum = _ExecutorImportance.MEDIUM

        slug = _slugify(title)
        bare_filename = f"{slug}.md"
        cat_dir = (
            Path(self.memory_dir) if cat == "root"
            else Path(self.memory_dir) / cat
        )
        candidate = cat_dir / bare_filename
        if candidate.exists():
            counter = 1
            while (cat_dir / f"{slug}-{counter}.md").exists():
                counter += 1
            bare_filename = f"{slug}-{counter}.md"

        passthrough: Dict[str, Any] = {
            "aliases": [],
            "source": source,
            "session_id": f"curated:{self.username}",
            "linked_from": [],
            "links_to": list(all_links),
        }
        draft = NoteDraft(
            title=title,
            body=content,
            category=cat,
            tags=list(tag_list),
            importance=importance_enum,
            scope=Scope.USER,
            filename=bare_filename,
            frontmatter=passthrough,
        )
        try:
            meta = run_coro_sync(self._provider.notes().write(draft))
        except Exception:
            logger.warning(
                "CuratedKnowledgeManager.write_note: provider write failed",
                exc_info=True,
            )
            return None
        bare_returned = meta.ref.filename or bare_filename
        filename = bare_returned if cat == "root" else f"{cat}/{bare_returned}"
        logger.info(
            "CuratedKnowledgeManager: wrote note '%s' → %s (source=%s)",
            title, filename, source,
        )
        return filename

    def update_note(
        self,
        filename: str,
        *,
        body: Optional[str] = None,
        tags: Optional[List[str]] = None,
        importance: Optional[str] = None,
        category: Optional[str] = None,
    ) -> bool:
        if self._provider is None:
            return False
        from geny_executor.memory.provider import (
            Importance as _ExecutorImportance,
            NotePatch,
        )
        from service.memory.sync_async_bridge import run_coro_sync

        bare = Path(filename).name
        notes = self._provider.notes()
        try:
            existing = run_coro_sync(notes.read(bare))
        except Exception:
            return False
        if existing is None:
            return False

        merged_tags: Optional[List[str]] = None
        if tags:
            merged = set(existing.tags or [])
            merged.update(t.lower().strip() for t in tags if t.strip())
            merged_tags = sorted(merged)

        importance_enum = None
        if importance:
            try:
                importance_enum = _ExecutorImportance(importance)
            except ValueError:
                importance_enum = None

        patch = NotePatch(
            body=body,
            tags=merged_tags,
            importance=importance_enum,
            category=category,
        )
        try:
            run_coro_sync(notes.update(bare, patch))
        except Exception:
            return False
        return True

    def delete_note(self, filename: str) -> bool:
        if self._provider is None:
            return False
        from service.memory.sync_async_bridge import run_coro_sync

        bare = Path(filename).name
        try:
            return bool(run_coro_sync(self._provider.notes().delete(bare)))
        except Exception:
            return False

    def create_link(self, source_filename: str, target_filename: str) -> bool:
        """Create a wikilink between two curated notes."""
        if self._provider is None:
            return False
        note = self.read_note(source_filename)
        if note is None:
            return False
        body = note.get("body", "")
        link_ref = f"[[{target_filename}]]"
        if link_ref not in body:
            body = body.rstrip() + f"\n\n{link_ref}\n"
            return self.update_note(source_filename, body=body)
        return True

    def reindex(self) -> int:
        """Rebuild the full index from disk."""
        if self._provider is None:
            return 0
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            run_coro_sync(self._provider.index().rebuild())
            payload = run_coro_sync(self._provider.index().snapshot())
            files = payload.get("files") or {}
            return int(payload.get("total_files", len(files)) or len(files))
        except Exception:
            return 0

    async def reindex_vector(self) -> Dict[str, int]:
        """Re-index all curated notes for vector search.

        With the executor-backed vector handle, the index is kept up
        to date by the auto-vector hook on every note write. This
        method exists as a manual reindex trigger; it returns the
        post-reindex chunk count when supported.
        """
        if self._provider is None or not self._vector_enabled:
            return {}
        vector = self._provider.vector()
        if vector is None:
            return {}
        try:
            plan = await vector.reindex()
            return {
                "indexed": getattr(plan, "indexed", 0),
                "skipped": getattr(plan, "skipped", 0),
            }
        except Exception:
            logger.debug(
                "CuratedKnowledgeManager.reindex_vector: failed",
                exc_info=True,
            )
            return {}

    # ── Promote / Curate Operations ───────────────────────────────────

    def promote_from_session(
        self,
        session_memory_manager,
        filename: str,
        *,
        session_id: str = "",
    ) -> Optional[str]:
        """Promote a note from session memory into curated knowledge.

        Returns the new curated filename, or None on failure.
        """
        note = session_memory_manager.read_note(filename)
        if note is None:
            logger.warning("promote_from_session: note not found: %s", filename)
            return None

        meta = note.get("metadata") or {}
        body = note.get("body") or ""

        tags = list(meta.get("tags") or [])
        if "promoted" not in tags:
            tags.append("promoted")

        importance = meta.get("importance", "medium")
        category = meta.get("category", "topics")
        title = meta.get("title", filename.replace(".md", ""))

        curated_filename = self.write_note(
            title=title,
            content=body,
            category=category,
            tags=tags,
            importance=importance,
            source="promoted",
            source_filename=filename,
        )

        # Surface the promotion on the operator-facing log channel.
        # Routed via the session id of the *source* turn (the caller
        # passes it in) — that's the session whose VTuber LOGS panel
        # the operator is watching.
        if curated_filename:
            try:
                from service.memory.event_emitter import emit_memory_event

                emit_memory_event(
                    session_id,
                    event_type="curated_promoted",
                    source="Curated",
                    layer="curated",
                    importance=importance,
                    category=category,
                    path=curated_filename,
                    chars=len(body),
                    message=(
                        f"curated_promoted: {filename} → {curated_filename} "
                        f"(importance={importance})"
                    ),
                    extra={"title": title, "source_filename": filename},
                )
            except Exception:  # noqa: BLE001
                logger.debug(
                    "CuratedKnowledgeManager: promote memory_event emit skipped",
                    exc_info=True,
                )
        return curated_filename

    def curate_from_opsidian(
        self,
        user_opsidian_manager,
        filename: str,
        *,
        transformed_content: Optional[str] = None,
        extra_tags: Optional[List[str]] = None,
        importance_override: Optional[str] = None,
    ) -> Optional[str]:
        """Curate a note from the user's Opsidian vault into curated knowledge.

        Optionally transforms the content (e.g., LLM-refined summary).

        Args:
            user_opsidian_manager: The source UserOpsidianManager.
            filename: Source note filename in User Opsidian.
            transformed_content: If provided, uses this instead of raw content.
            extra_tags: Additional tags to add.
            importance_override: Override the importance level.

        Returns:
            New curated filename, or None on failure.
        """
        note = user_opsidian_manager.read_note(filename)
        if note is None:
            logger.warning("curate_from_opsidian: note not found: %s", filename)
            return None

        meta = note.get("metadata") or {}
        body = transformed_content or note.get("body") or ""

        tags = list(meta.get("tags") or [])
        if extra_tags:
            tags.extend(extra_tags)

        return self.write_note(
            title=meta.get("title", filename.replace(".md", "")),
            content=body,
            category=meta.get("category", "topics"),
            tags=tags,
            importance=importance_override or meta.get("importance", "medium"),
            source="auto-curated",
            source_filename=filename,
        )

    # ── Context Injection ─────────────────────────────────────────────

    def inject_context(
        self,
        query: str,
        max_chars: int = 5000,
    ) -> str:
        """Build a curated knowledge context block for prompt injection.

        Uses keyword search. For vector search, use `vector_inject_context`.
        Returns formatted XML-tagged text or empty string.
        """
        results = self.search(query, max_results=5)
        if not results:
            return ""

        parts = []
        total = 0
        for r in results:
            snippet = r.get("snippet", "")
            fn = r.get("filename", "")
            importance = r.get("importance", "medium")
            chunk = (
                f'<curated-knowledge source="{fn}" importance="{importance}">\n'
                f"{snippet}\n"
                f"</curated-knowledge>"
            )
            if total + len(chunk) > max_chars:
                break
            parts.append(chunk)
            total += len(chunk)

        return "\n\n".join(parts)

    async def vector_inject_context(
        self,
        query: str,
        max_chars: int = 5000,
        top_k: int = 5,
    ) -> str:
        """Build a curated knowledge context block using vector search.

        Returns formatted XML-tagged text or empty string.
        """
        if self._provider is None or not self._vector_enabled:
            return ""
        vector = self._provider.vector()
        if vector is None:
            return ""

        try:
            chunks = await vector.search(query, top_k=top_k)
        except Exception:
            return ""
        if not chunks:
            return ""

        budget = max_chars
        parts = []
        total = 0
        for c in chunks:
            source_file = (
                (c.metadata.get("filename") or c.key) if c.metadata else c.key
            )
            chunk_index = (
                int(c.metadata.get("chunk_index", 0)) if c.metadata else 0
            )
            block = (
                f'<curated-knowledge source="{source_file}" '
                f'score="{c.relevance_score:.3f}" chunk="{chunk_index}">\n'
                f"{c.content}\n"
                f"</curated-knowledge>"
            )
            if total + len(block) > budget:
                break
            parts.append(block)
            total += len(block)

        return "\n\n".join(parts)


# ── Manager cache (username → manager) ────────────────────────────────

_curated_managers: Dict[str, CuratedKnowledgeManager] = {}


def get_curated_knowledge_manager(username: str) -> CuratedKnowledgeManager:
    """Get or create the CuratedKnowledgeManager for a given user."""
    if username not in _curated_managers:
        _curated_managers[username] = CuratedKnowledgeManager(username)
    return _curated_managers[username]
