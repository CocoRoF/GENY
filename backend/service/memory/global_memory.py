"""
Global Memory Manager — Cross-session shared knowledge store.

Provides a singleton global memory that all sessions can read from
and promote notes to. The manager owns its own single-tenant
``MemoryProvider`` (file-backed, rooted at ``<storage>/_global_memory``)
so every operation flows through ``provider.notes()`` /
``provider.index()`` directly — no host-side adapters.

Sync + async dual surface (Step 7-2): every public method has an
``a*`` async sibling. Sync wrappers call into the async path via
``run_coro_sync``; async callers (controllers, agent_session, tools
that override ``arun``) should prefer the ``a*`` form to skip the
bridge.
"""

from __future__ import annotations

import os
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from service.memory.note_utils import compute_total_links

logger = getLogger(__name__)


class GlobalMemoryManager:
    """Cross-session global memory for shared knowledge.

    Uses the same structured note format (YAML frontmatter + Markdown)
    as session-level memory, but stored in a shared ``_global_memory/``
    directory accessible to all sessions.
    """

    def __init__(self, base_path: Optional[str] = None):
        if base_path is None:
            base_path = self._default_path()
        self.memory_dir = os.path.join(base_path, "_global_memory")
        os.makedirs(self.memory_dir, exist_ok=True)

        self._provider: Optional[Any] = None
        self._db = None
        self._initialize()

    @staticmethod
    def _default_path() -> str:
        from service.utils.platform import DEFAULT_STORAGE_ROOT
        return DEFAULT_STORAGE_ROOT

    def _initialize(self):
        """Build the single-tenant `MemoryProvider`."""
        try:
            from service.memory.provider_bridge import build_single_tenant_provider
            from service.memory.sync_async_bridge import run_coro_sync

            self._provider = run_coro_sync(
                build_single_tenant_provider(
                    root=self.memory_dir,
                    scope_id="global",
                    scope="session",
                )
            )
            logger.info(
                "GlobalMemoryManager initialized at %s", self.memory_dir,
            )
        except Exception:
            logger.warning(
                "GlobalMemoryManager: init failed (non-critical)",
                exc_info=True,
            )

    def set_database(self, db):
        """Attach database connection (analytics mirror)."""
        self._db = db

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
            "source": "global",
            "char_count": meta.size_bytes,
            "links_to": [],
            "linked_from": [],
            "summary": None,
        }

    # ── Read Operations (async-native) ───────────────────────────────

    async def alist_notes(
        self,
        *,
        category: Optional[str] = None,
        tag: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        if self._provider is None:
            return []
        try:
            metas = await self._provider.notes().list(category=category, tag=tag)
        except Exception:
            logger.debug("GlobalMemoryManager.alist_notes: failed", exc_info=True)
            return []
        return [self._meta_to_dict(m) for m in metas]

    def list_notes(
        self,
        *,
        category: Optional[str] = None,
        tag: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.alist_notes(category=category, tag=tag))

    async def aread_note(self, filename: str) -> Optional[Dict[str, Any]]:
        if self._provider is None:
            return None
        bare = Path(filename).name
        try:
            note = await self._provider.notes().read(bare)
        except Exception:
            logger.debug(
                "GlobalMemoryManager.aread_note(%s): failed", filename,
                exc_info=True,
            )
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

    def read_note(self, filename: str) -> Optional[Dict[str, Any]]:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.aread_note(filename))

    async def asearch(self, query: str, max_results: int = 5) -> List[Dict[str, Any]]:
        """Simple keyword search across global notes (async)."""
        if self._provider is None:
            return []
        all_notes = await self.alist_notes()
        query_lower = query.lower()
        results = []
        for note_info in all_notes:
            fn = note_info["filename"]
            note = await self.aread_note(fn)
            if note is None:
                continue
            body = (note.get("body") or "").lower()
            title = (note.get("metadata", {}).get("title") or "").lower()
            tags = note.get("metadata", {}).get("tags") or []
            score = 0.0
            if query_lower in title:
                score += 2.0
            if query_lower in body:
                score += 1.0
            for tag in tags:
                if query_lower in tag.lower():
                    score += 0.5
            if score > 0:
                results.append({
                    **note_info,
                    "score": score,
                    "snippet": (note.get("body") or "")[:300],
                })
        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:max_results]

    def search(self, query: str, max_results: int = 5) -> List[Dict[str, Any]]:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.asearch(query, max_results))

    async def aget_index(self) -> Optional[Dict[str, Any]]:
        if self._provider is None:
            return None
        try:
            payload = await self._provider.index().snapshot()
        except Exception:
            logger.debug("GlobalMemoryManager.aget_index: failed", exc_info=True)
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
                }
                for k, v in files.items()
            },
            "tag_map": payload.get("tag_map", {}),
            "total_files": int(payload.get("total_files", len(files)) or len(files)),
            "total_chars": int(payload.get("total_chars", 0) or 0),
        }

    def get_index(self) -> Optional[Dict[str, Any]]:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.aget_index())

    async def aget_stats(self) -> Dict[str, Any]:
        idx = await self.aget_index()
        if idx is None:
            return {"total_files": 0, "total_chars": 0}
        categories: Dict[str, int] = {}
        for info in (idx.get("files") or {}).values():
            cat = info.get("category", "unknown")
            categories[cat] = categories.get(cat, 0) + 1
        return {
            "total_files": idx.get("total_files", 0),
            "total_chars": idx.get("total_chars", 0),
            "categories": categories,
            "total_tags": len(idx.get("tag_map", {})),
            "total_links": compute_total_links(idx),
        }

    def get_stats(self) -> Dict[str, Any]:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.aget_stats())

    # ── Write Operations (async-native) ──────────────────────────────

    async def awrite_note(
        self,
        title: str,
        content: str,
        *,
        category: str = "topics",
        tags: Optional[List[str]] = None,
        importance: str = "medium",
        source: str = "global",
        source_session_id: Optional[str] = None,
    ) -> Optional[str]:
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

        cat = category if category in VALID_CATEGORIES else "topics"
        tag_list = [t.lower().strip() for t in (tags or []) if t.strip()]
        all_links = list(set(extract_wikilinks(content)))

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
            "session_id": source_session_id or "global",
            "linked_from": [],
            "links_to": list(all_links),
        }
        draft = NoteDraft(
            title=title,
            body=content,
            category=cat,
            tags=list(tag_list),
            importance=importance_enum,
            scope=Scope.SESSION,
            filename=bare_filename,
            frontmatter=passthrough,
        )
        try:
            meta = await self._provider.notes().write(draft)
        except Exception:
            logger.warning(
                "GlobalMemoryManager.awrite_note: provider write failed",
                exc_info=True,
            )
            return None
        bare_returned = meta.ref.filename or bare_filename
        return bare_returned if cat == "root" else f"{cat}/{bare_returned}"

    def write_note(
        self,
        title: str,
        content: str,
        *,
        category: str = "topics",
        tags: Optional[List[str]] = None,
        importance: str = "medium",
        source: str = "global",
        source_session_id: Optional[str] = None,
    ) -> Optional[str]:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.awrite_note(
            title, content,
            category=category, tags=tags, importance=importance,
            source=source, source_session_id=source_session_id,
        ))

    async def aupdate_note(
        self,
        filename: str,
        *,
        body: Optional[str] = None,
        tags: Optional[List[str]] = None,
        importance: Optional[str] = None,
    ) -> bool:
        if self._provider is None:
            return False
        from geny_executor.memory.provider import (
            Importance as _ExecutorImportance,
            NotePatch,
        )

        bare = Path(filename).name
        notes = self._provider.notes()
        try:
            existing = await notes.read(bare)
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
        )
        try:
            await notes.update(bare, patch)
        except Exception:
            return False
        return True

    def update_note(
        self,
        filename: str,
        *,
        body: Optional[str] = None,
        tags: Optional[List[str]] = None,
        importance: Optional[str] = None,
    ) -> bool:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.aupdate_note(
            filename, body=body, tags=tags, importance=importance,
        ))

    async def adelete_note(self, filename: str) -> bool:
        if self._provider is None:
            return False
        bare = Path(filename).name
        try:
            return bool(await self._provider.notes().delete(bare))
        except Exception:
            return False

    def delete_note(self, filename: str) -> bool:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.adelete_note(filename))

    # ── Promote from Session ──────────────────────────────────────────

    async def apromote(
        self,
        session_memory_manager,
        filename: str,
        *,
        session_id: str = "",
    ) -> Optional[str]:
        """Copy a note from session memory to global memory (async)."""
        # Prefer async siblings on the session manager when available.
        aread = getattr(session_memory_manager, "aread_note", None)
        if callable(aread):
            note = await aread(filename)
        else:
            note = session_memory_manager.read_note(filename)
        if note is None:
            logger.warning(
                "promote: source note not found: %s", filename,
            )
            return None

        meta = note.get("metadata") or {}
        body = note.get("body") or ""

        tags = list(meta.get("tags") or [])
        if "promoted" not in tags:
            tags.append("promoted")

        global_fn = await self.awrite_note(
            title=meta.get("title", filename.replace(".md", "")),
            content=body,
            category=meta.get("category", "topics"),
            tags=tags,
            importance=meta.get("importance", "medium"),
            source="promoted",
            source_session_id=session_id,
        )

        if global_fn:
            logger.info(
                "promote: %s → global %s (from session %s)",
                filename, global_fn, session_id or "unknown",
            )
        return global_fn

    def promote(
        self,
        session_memory_manager,
        filename: str,
        *,
        session_id: str = "",
    ) -> Optional[str]:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.apromote(
            session_memory_manager, filename, session_id=session_id,
        ))

    async def ainject_context(
        self,
        query: str,
        max_chars: int = 4000,
    ) -> str:
        """Build a global memory context block (async)."""
        results = await self.asearch(query, max_results=5)
        if not results:
            return ""

        parts = []
        total = 0
        for r in results:
            snippet = r.get("snippet", "")
            fn = r.get("filename", "")
            chunk = (
                f'<global-memory source="{fn}">\n'
                f"{snippet}\n"
                f"</global-memory>"
            )
            if total + len(chunk) > max_chars:
                break
            parts.append(chunk)
            total += len(chunk)

        return "\n\n".join(parts)

    def inject_context(
        self,
        query: str,
        max_chars: int = 4000,
    ) -> str:
        from service.memory.sync_async_bridge import run_coro_sync
        return run_coro_sync(self.ainject_context(query, max_chars))


# ── Singleton ─────────────────────────────────────────────────────────

_global_memory_manager: Optional[GlobalMemoryManager] = None


def get_global_memory_manager() -> GlobalMemoryManager:
    """Get or create the singleton global memory manager."""
    global _global_memory_manager
    if _global_memory_manager is None:
        _global_memory_manager = GlobalMemoryManager()
    return _global_memory_manager
