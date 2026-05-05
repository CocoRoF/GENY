"""
User Opsidian Manager — Personal knowledge base per user.

Unlike session memory (scoped to a session) or global memory (shared across
sessions), the User Opsidian is a private knowledge vault that belongs to a
specific user.  Users can store personal notes, ideas, and structured
information that persists independently of any agent session.

Storage layout::

    {STORAGE_ROOT}/_user_opsidian/{username}/
        daily/
        topics/
        projects/
        insights/
        _index.json

Each user gets their own single-tenant ``MemoryProvider`` (file-backed,
scope=user) so every read/write/index call routes through
``provider.notes()`` / ``provider.index()`` directly — no host-side
adapters.
"""

from __future__ import annotations

import os
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)


class UserOpsidianManager:
    """Per-user personal knowledge vault with Obsidian-like notes.

    Each user gets an isolated directory under ``_user_opsidian/{username}/``
    backed by a dedicated single-tenant ``MemoryProvider``.
    """

    def __init__(self, username: str, base_path: Optional[str] = None):
        if base_path is None:
            base_path = self._default_path()
        self.username = username
        self.memory_dir = os.path.join(base_path, "_user_opsidian", username)
        os.makedirs(self.memory_dir, exist_ok=True)

        self._provider: Optional[Any] = None
        self._initialize()

    @staticmethod
    def _default_path() -> str:
        from service.utils.platform import DEFAULT_STORAGE_ROOT
        return DEFAULT_STORAGE_ROOT

    def _initialize(self):
        """Build the per-user single-tenant `MemoryProvider`."""
        try:
            from service.memory.provider_bridge import build_single_tenant_provider
            from service.memory.sync_async_bridge import run_coro_sync

            self._provider = run_coro_sync(
                build_single_tenant_provider(
                    root=self.memory_dir,
                    scope_id=f"user:{self.username}",
                    scope="user",
                )
            )
            logger.info(
                "UserOpsidianManager initialized for '%s' at %s",
                self.username, self.memory_dir,
            )
        except Exception:
            logger.warning(
                "UserOpsidianManager: init failed for '%s' (non-critical)",
                self.username, exc_info=True,
            )

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
            logger.debug("UserOpsidianManager.list_notes: failed", exc_info=True)
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
            "source": "user",
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
        """Keyword search across user notes."""
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

    def get_index(self) -> Optional[Dict[str, Any]]:
        if self._provider is None:
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            payload = run_coro_sync(self._provider.index().snapshot())
        except Exception:
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
            return {"total_files": 0, "total_chars": 0, "categories": {}, "total_tags": 0}
        categories: Dict[str, int] = {}
        for info in (idx.get("files") or {}).values():
            cat = info.get("category", "unknown")
            categories[cat] = categories.get(cat, 0) + 1
        return {
            "total_files": idx.get("total_files", 0),
            "total_chars": idx.get("total_chars", 0),
            "categories": categories,
            "total_tags": len(idx.get("tag_map", {})),
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
        source: str = "user",
        links_to: Optional[List[str]] = None,
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
        from service.memory.sync_async_bridge import run_coro_sync

        cat = category if category in VALID_CATEGORIES else "topics"
        tag_list = [t.lower().strip() for t in (tags or []) if t.strip()]
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
            "session_id": f"user:{self.username}",
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
                "UserOpsidianManager.write_note: provider write failed",
                exc_info=True,
            )
            return None
        bare_returned = meta.ref.filename or bare_filename
        return bare_returned if cat == "root" else f"{cat}/{bare_returned}"

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
        """Create a wikilink between two notes."""
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


# ── Manager cache (username → manager) ────────────────────────────────

_user_managers: Dict[str, UserOpsidianManager] = {}


def get_user_opsidian_manager(username: str) -> UserOpsidianManager:
    """Get or create the UserOpsidianManager for a given user."""
    if username not in _user_managers:
        _user_managers[username] = UserOpsidianManager(username)
    return _user_managers[username]
