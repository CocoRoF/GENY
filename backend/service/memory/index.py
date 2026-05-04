"""
Memory Index — thin adapter over `provider.index()`.

Path-A migration GENY-4. The on-disk `_index.json` cache, tag map,
link graph, and vault map render are owned by the executor's
`IndexHandle`. This module preserves the legacy `MemoryIndexManager`
surface (`index_manager.index.files`, `.tag_map`, `.link_graph`,
`.update_file`, `.rebuild`, `.render_vault_map`, `.build_vault_map`)
that the rest of Geny attribute-accesses, but every read is a lazy
snapshot of the executor's index and every mutation is a cache
invalidation that the executor will refresh on its own.

Geny still owns:
- `_CATEGORY_DESCRIPTIONS` — Geny-specific labels for the vault map
  (`critical = always-pinned facts`, etc.); fed to the executor's
  `render_vault_map(category_descriptions=...)` so the rendered
  block matches the legacy operator-prompt layout.
- `_vault_map.json` — operator-side cache for the system prompt.
  Written next to (not on top of) the executor's `_index.json`.
- `MemoryFileInfo` / `MemoryIndex` dataclasses — caller compatibility.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = getLogger(__name__)

# Use configured timezone from GENY_TIMEZONE env var
from service.utils.utils import _configured_tz as _get_tz


_INDEX_FILE = "_index.json"
_VAULT_MAP_FILE = "_vault_map.json"


#: One-line description per category surfaced in the system-prompt
#: vault map. Geny-specific labels — fed to the executor's
#: ``render_vault_map(category_descriptions=...)`` so the rendered
#: block matches the legacy operator-prompt layout.
_CATEGORY_DESCRIPTIONS: Dict[str, str] = {
    "conversations": "Per-session conversation rollups, split by counterpart bucket (user / reflection / dm / system).",
    "dms": "Per-counterpart-per-day DM index bundles.",
    "critical": "Always-pinned facts about the user, persona, and binding decisions; injected into every prompt.",
    "insights": "LLM-distilled facts curated from past conversations.",
    "topics": "Curated subject pages (free-form notes the agent can read/write).",
    "projects": "Curated initiative pages tracking ongoing work.",
    "daily": "Per-execution result cards (one per agent run).",
    "executions": "Append-only execution-summary stream organised by date.",
    "compactions": "Compaction artefacts written by the s02 context compactor.",
    "root": "Root-level files (MEMORY.md and any uncategorised .md).",
}


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.stem + ".", suffix=".json.tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, default=str)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


@dataclass
class MemoryFileInfo:
    """Metadata for a single memory file. Caller-compatible shape."""
    filename: str = ""
    title: str = ""
    category: str = "topics"
    tags: List[str] = field(default_factory=list)
    importance: str = "medium"
    created: str = ""
    modified: str = ""
    source: str = "system"
    char_count: int = 0
    links_to: List[str] = field(default_factory=list)
    linked_from: List[str] = field(default_factory=list)
    summary: Optional[str] = None
    # InteractionEvent dimensions — only populated for `conversations/`
    # files whose frontmatter (or `metadata` extension) carries them.
    # Empty string elsewhere; legacy filters bypass when empty.
    event_id: str = ""
    kind: str = ""
    direction: str = ""
    counterpart: str = ""
    counterpart_role: str = ""
    linked_event_id: str = ""
    session_id: str = ""
    turn_count: int = 0
    event_ids: List[str] = field(default_factory=list)
    kinds: List[str] = field(default_factory=list)
    counterparts: List[str] = field(default_factory=list)
    importance_max: str = ""
    date_first: str = ""
    date_last: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MemoryFileInfo":
        fields = {k for k in cls.__dataclass_fields__}
        filtered = {k: v for k, v in d.items() if k in fields}
        return cls(**filtered)


@dataclass
class MemoryIndex:
    """Full index snapshot. Caller-compatible shape."""
    files: Dict[str, MemoryFileInfo] = field(default_factory=dict)
    tag_map: Dict[str, List[str]] = field(default_factory=dict)
    link_graph: Dict[str, List[str]] = field(default_factory=dict)
    last_rebuilt: str = ""
    total_chars: int = 0
    total_files: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "files": {k: v.to_dict() for k, v in self.files.items()},
            "tag_map": self.tag_map,
            "link_graph": self.link_graph,
            "last_rebuilt": self.last_rebuilt,
            "total_chars": self.total_chars,
            "total_files": self.total_files,
        }


class MemoryIndexManager:
    """Thin adapter over `provider.index()`.

    The executor maintains the canonical `_index.json` cache; this
    wrapper hands the snapshot to legacy callers in their expected
    shape, and routes vault-map rendering through the executor with
    Geny's category descriptions injected.

    Construction stays compatible with pre-migration call sites
    (`MemoryIndexManager(memory_dir)`); attach the executor provider
    via `set_memory_provider(provider)` once available. Without a
    provider the index returns empty.
    """

    def __init__(self, memory_dir: str):
        self._memory_dir = Path(memory_dir)
        self._index_path = self._memory_dir / _INDEX_FILE
        self._vault_map_path = self._memory_dir / _VAULT_MAP_FILE
        self._cached_index: Optional[MemoryIndex] = None
        self._provider: Any = None

    def set_memory_provider(self, provider: Any) -> None:
        self._provider = provider
        self._cached_index = None  # next access re-snapshots

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    @property
    def index(self) -> MemoryIndex:
        """Lazy snapshot of the executor's IndexHandle."""
        if self._cached_index is None:
            self._cached_index = self._build_snapshot()
        return self._cached_index

    def load_or_rebuild(self) -> MemoryIndex:
        return self.index

    def rebuild(self) -> MemoryIndex:
        """Force a fresh snapshot from the executor."""
        if self._provider is not None:
            from service.memory.sync_async_bridge import run_coro_sync

            try:
                run_coro_sync(self._provider.index().rebuild())
            except Exception:  # noqa: BLE001
                logger.debug("MemoryIndex.rebuild: provider rebuild failed", exc_info=True)
        self._cached_index = None
        return self.index

    def update_file(self, relative_path: str) -> Optional[MemoryFileInfo]:
        """Invalidate the snapshot — the executor's IndexHandle has
        already absorbed the write through `after_note_write`. Return
        the file's current info if it still exists."""
        self._cached_index = None
        idx = self.index
        bare = Path(relative_path).name
        return idx.files.get(bare) or idx.files.get(relative_path)

    def remove_file(self, relative_path: str) -> None:
        self._cached_index = None

    # ── query helpers (unchanged caller surface) ─────────────────────

    def get_files_by_tag(self, tag: str) -> List[MemoryFileInfo]:
        idx = self.index
        filenames = idx.tag_map.get(tag.lower(), [])
        return [idx.files[fn] for fn in filenames if fn in idx.files]

    def get_files_by_category(self, category: str) -> List[MemoryFileInfo]:
        idx = self.index
        return [f for f in idx.files.values() if f.category == category]

    def get_files_by_importance(self, importance: str) -> List[MemoryFileInfo]:
        idx = self.index
        return [f for f in idx.files.values() if f.importance == importance]

    def get_all_tags(self) -> Dict[str, int]:
        idx = self.index
        return {tag: len(files) for tag, files in idx.tag_map.items()}

    def get_link_graph(self) -> Dict[str, List[str]]:
        return dict(self.index.link_graph)

    def get_backlinks(self, filename: str) -> List[str]:
        info = self.index.files.get(filename)
        return list(info.linked_from) if info else []

    def get_categories_summary(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for f in self.index.files.values():
            cat = f.category or "uncategorized"
            counts[cat] = counts.get(cat, 0) + 1
        return counts

    def search_by_title(self, query: str) -> List[MemoryFileInfo]:
        q = query.lower()
        return [f for f in self.index.files.values() if q in f.title.lower()]

    # ── vault map render (executor-driven) ──────────────────────────

    def build_vault_map(self) -> Dict[str, Any]:
        """Snapshot suitable for prompt-injection rendering.

        Routed through the executor's `IndexHandle.build_vault_map`
        with Geny's `_CATEGORY_DESCRIPTIONS` injected. Falls back to
        an empty payload when the provider isn't attached yet.
        """
        if self._provider is None:
            return {
                "categories": {},
                "top_tags": [],
                "recently_modified": [],
                "memory_md_preview": "",
                "total_files": 0,
                "generated_at": datetime.now(_get_tz()).isoformat(),
            }
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            return run_coro_sync(
                self._provider.index().build_vault_map(
                    category_descriptions=_CATEGORY_DESCRIPTIONS,
                )
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "MemoryIndex.build_vault_map: provider call failed",
                exc_info=True,
            )
            return {
                "categories": {},
                "top_tags": [],
                "recently_modified": [],
                "memory_md_preview": "",
                "total_files": 0,
                "generated_at": datetime.now(_get_tz()).isoformat(),
            }

    def render_vault_map(self) -> str:
        """Markdown block ready for the system prompt.

        Routed through the executor's `IndexHandle.render_vault_map`
        with Geny's category descriptions injected. Geny also caches
        the rendered block to `_vault_map.json` for operator
        analytics — the executor's `_index.json` is untouched here.
        """
        if self._provider is None:
            return "## Vault Map"
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            block = run_coro_sync(
                self._provider.index().render_vault_map(
                    category_descriptions=_CATEGORY_DESCRIPTIONS,
                )
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "MemoryIndex.render_vault_map: provider call failed",
                exc_info=True,
            )
            block = "## Vault Map"

        # Best-effort cache for operator analytics; failure is silent.
        try:
            _atomic_write_json(self._vault_map_path, {"rendered": block})
        except Exception:  # noqa: BLE001
            pass
        return block

    # ── snapshot builder ────────────────────────────────────────────

    def _build_snapshot(self) -> MemoryIndex:
        if self._provider is None:
            return MemoryIndex()
        from service.memory.sync_async_bridge import run_coro_sync

        try:
            payload = run_coro_sync(self._provider.index().snapshot())
        except Exception:  # noqa: BLE001
            logger.debug("MemoryIndex._build_snapshot failed", exc_info=True)
            return MemoryIndex()

        files: Dict[str, MemoryFileInfo] = {}
        for fname, entry in (payload.get("files") or {}).items():
            files[fname] = MemoryFileInfo.from_dict(entry)
        tag_map = {
            tag: list(names) for tag, names in (payload.get("tag_map") or {}).items()
        }
        link_graph = {
            src: list(targets)
            for src, targets in (payload.get("link_graph") or {}).items()
        }
        return MemoryIndex(
            files=files,
            tag_map=tag_map,
            link_graph=link_graph,
            last_rebuilt=str(payload.get("last_rebuilt", "")),
            total_chars=int(payload.get("total_chars", 0) or 0),
            total_files=int(payload.get("total_files", len(files)) or len(files)),
        )
