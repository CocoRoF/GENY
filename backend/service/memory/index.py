"""
Memory Index — In-memory + JSON-cached index of all memory files.

Maintains a fast lookup structure for file metadata, tags, and
link relationships.  Persisted as ``_index.json`` inside the
memory directory and rebuilt on demand.
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from service.memory.frontmatter import (
    parse_frontmatter,
    extract_wikilinks,
)

logger = getLogger(__name__)

# Use configured timezone from GENY_TIMEZONE env var
from service.utils.utils import _configured_tz as _get_tz
_INDEX_FILE = "_index.json"
# Memory v2 PR 9 — vault map cache (~500 chars rendered) that the
# Static Layer of the system prompt injects in lieu of MEMORY.md
# body. Lives next to ``_index.json`` and is regenerated whenever
# the index rebuilds / updates.
_VAULT_MAP_FILE = "_vault_map.json"
_MD_PATTERN = re.compile(r"\.md$", re.IGNORECASE)

# Directories that are not user-facing categories.
_SKIP_DIRS = {"__pycache__", ".git", "_attachments"}

# Vault Map render limits (plan §3.3) — the rendered markdown that
# gets injected into the system prompt's Static Layer must stay tight.
_VAULT_MAP_RECENT_LIMIT = 5
_VAULT_MAP_TOP_TAGS = 10
_VAULT_MAP_MEMORY_PREVIEW_CHARS = 200


#: One-line description per category surfaced in the root
#: ``_index.json`` and rendered into the system-prompt vault map.
#: Helps the agent decide which folder to drill into when its
#: ``memory_list(category)`` tool is the right next move.
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
    """Write ``payload`` as JSON to ``path`` via tempfile + rename so
    a crash mid-write never leaves a half-baked file.
    """
    import os, tempfile  # local — keeps the eager import set lean

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=path.stem + ".",
        suffix=".json.tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _coerce_int_meta(value: Any) -> int:
    """Frontmatter ints come back as int|str|None; normalise to int."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def _coerce_list_meta(value: Any) -> List[str]:
    """Frontmatter lists come back as list|str|None; normalise to
    ``List[str]`` (lower-casing happens at the caller for fields that
    need it; these aggregates keep their original casing).
    """
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, (str, int, float)) and str(v) != ""]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


@dataclass
class MemoryFileInfo:
    """Metadata for a single memory file.

    Memory v2 PR 6 extends the historical 11 fields with the
    InteractionEvent dimensions a conversations/ note carries.
    They surface here so ``memory_search`` and the Opsidian
    Conversation view can filter by ``counterpart`` / ``kind`` /
    ``direction`` / ``event_id`` without re-parsing every
    frontmatter on every call. Notes outside conversations/ leave
    these as empty strings — the search tools just bypass the
    filter when the field is empty.
    """
    filename: str = ""            # relative path inside memory/ (e.g. "topics/python-async.md")
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
    # PR 6 — InteractionEvent dimensions (only populated for
    # ``conversations/`` notes; empty string elsewhere).
    event_id: str = ""
    kind: str = ""
    direction: str = ""
    counterpart: str = ""
    counterpart_role: str = ""
    linked_event_id: str = ""
    # PR 14 (cycle 20260503_5) — session-rollup aggregates surfaced
    # for ``conversations/`` files. Each rollup file carries N turns,
    # so per-file ``event_id`` / ``kind`` / ``direction`` / etc. are
    # ambiguous; we expose the deduped sets at file level instead.
    # ``session_id`` is also surfaced so downstream filters can
    # group rollups by session without re-reading frontmatter.
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
    """Full index of all memory files in a session."""
    files: Dict[str, MemoryFileInfo] = field(default_factory=dict)   # filename → info
    tag_map: Dict[str, List[str]] = field(default_factory=dict)      # tag → [filenames]
    link_graph: Dict[str, List[str]] = field(default_factory=dict)   # filename → [linked filenames]
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

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MemoryIndex":
        files = {}
        for k, v in d.get("files", {}).items():
            files[k] = MemoryFileInfo.from_dict(v)
        return cls(
            files=files,
            tag_map=d.get("tag_map", {}),
            link_graph=d.get("link_graph", {}),
            last_rebuilt=d.get("last_rebuilt", ""),
            total_chars=d.get("total_chars", 0),
            total_files=d.get("total_files", 0),
        )


class MemoryIndexManager:
    """Manages the ``_index.json`` file and provides query helpers.

    Thread-safe via a reentrant lock on mutations.

    Usage::

        idx_mgr = MemoryIndexManager("/sessions/abc/memory")
        idx_mgr.load_or_rebuild()

        # After writing a new file
        idx_mgr.update_file("topics/python-async.md")

        # Queries
        files = idx_mgr.get_files_by_tag("python")
        graph = idx_mgr.get_link_graph()
    """

    def __init__(self, memory_dir: str):
        self._memory_dir = Path(memory_dir)
        self._index_path = self._memory_dir / _INDEX_FILE
        self._vault_map_path = self._memory_dir / _VAULT_MAP_FILE
        self._index: Optional[MemoryIndex] = None
        self._lock = threading.RLock()

    @property
    def index(self) -> MemoryIndex:
        """Get the current index, loading or rebuilding if needed."""
        if self._index is None:
            self.load_or_rebuild()
        return self._index  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Load / Rebuild
    # ------------------------------------------------------------------

    def load_or_rebuild(self) -> MemoryIndex:
        """Load index from disk, or rebuild from files if missing/stale."""
        with self._lock:
            loaded = self._load_from_disk()
            if loaded is not None:
                self._index = loaded
                return loaded
            return self.rebuild()

    def rebuild(self) -> MemoryIndex:
        """Full rebuild: scan all .md files, parse frontmatter, rebuild index."""
        with self._lock:
            idx = MemoryIndex()

            if not self._memory_dir.exists():
                self._index = idx
                return idx

            md_files = self._list_md_files()
            for filepath in md_files:
                try:
                    info = self._scan_file(filepath)
                    if info:
                        idx.files[info.filename] = info
                except Exception as exc:
                    logger.debug("MemoryIndex: skip %s: %s", filepath, exc)

            # Rebuild derived structures
            self._rebuild_tag_map(idx)
            self._rebuild_link_graph(idx)
            self._compute_totals(idx)

            idx.last_rebuilt = datetime.now(_get_tz()).isoformat()
            self._index = idx
            self._save_to_disk()

            logger.info(
                "MemoryIndex rebuilt: %d files, %d chars, %d tags",
                idx.total_files, idx.total_chars, len(idx.tag_map),
            )
            return idx

    # ------------------------------------------------------------------
    # Incremental updates
    # ------------------------------------------------------------------

    def update_file(self, relative_path: str) -> Optional[MemoryFileInfo]:
        """Update (or add) a single file in the index.

        Args:
            relative_path: Path relative to memory_dir (e.g. "topics/python.md").

        Returns:
            Updated MemoryFileInfo, or None if file not found.
        """
        with self._lock:
            filepath = self._memory_dir / relative_path
            if not filepath.exists() or not filepath.is_file():
                # File removed — delete from index AND persist so the
                # category shard reflects the removal (cycle
                # 20260503_6: hierarchical index needs the per-shard
                # write to drop entries; the legacy monolithic save
                # was implicitly handled by the next ``rebuild``).
                self._remove_from_index(relative_path)
                self._save_to_disk()
                return None

            info = self._scan_file(filepath)
            if not info:
                return None

            idx = self.index
            idx.files[info.filename] = info

            # Rebuild derived structures
            self._rebuild_tag_map(idx)
            self._rebuild_link_graph(idx)
            self._compute_totals(idx)
            idx.last_rebuilt = datetime.now(_get_tz()).isoformat()

            self._save_to_disk()
            return info

    def remove_file(self, relative_path: str) -> None:
        """Remove a file from the index."""
        with self._lock:
            self._remove_from_index(relative_path)
            self._save_to_disk()

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def get_files_by_tag(self, tag: str) -> List[MemoryFileInfo]:
        """Get all files that have a specific tag."""
        idx = self.index
        filenames = idx.tag_map.get(tag.lower(), [])
        return [idx.files[fn] for fn in filenames if fn in idx.files]

    def get_files_by_category(self, category: str) -> List[MemoryFileInfo]:
        """Get all files in a specific category."""
        idx = self.index
        return [f for f in idx.files.values() if f.category == category]

    def get_files_by_importance(self, importance: str) -> List[MemoryFileInfo]:
        """Get all files with a specific importance level."""
        idx = self.index
        return [f for f in idx.files.values() if f.importance == importance]

    def get_all_tags(self) -> Dict[str, int]:
        """Get all tags with their file counts."""
        idx = self.index
        return {tag: len(files) for tag, files in idx.tag_map.items()}

    def get_link_graph(self) -> Dict[str, List[str]]:
        """Get the full link graph (filename → linked filenames)."""
        return dict(self.index.link_graph)

    def get_backlinks(self, filename: str) -> List[str]:
        """Get files that link TO the given file."""
        info = self.index.files.get(filename)
        if info:
            return list(info.linked_from)
        return []

    def get_categories_summary(self) -> Dict[str, int]:
        """Get category → file count mapping."""
        counts: Dict[str, int] = {}
        for f in self.index.files.values():
            cat = f.category or "uncategorized"
            counts[cat] = counts.get(cat, 0) + 1
        return counts

    def search_by_title(self, query: str) -> List[MemoryFileInfo]:
        """Simple title substring search."""
        q = query.lower()
        return [f for f in self.index.files.values() if q in f.title.lower()]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _scan_file(self, filepath: Path) -> Optional[MemoryFileInfo]:
        """Scan a single .md file and extract MemoryFileInfo."""
        try:
            stat = filepath.stat()
            if stat.st_size == 0 or stat.st_size > 256_000:
                return None

            content = filepath.read_text(encoding="utf-8")
            relative = str(filepath.relative_to(self._memory_dir)).replace("\\", "/")

            metadata, body = parse_frontmatter(content)

            # Infer category from directory
            parts = relative.split("/")
            inferred_category = parts[0] if len(parts) > 1 else "root"
            if inferred_category in ("_attachments", "__pycache__"):
                return None

            # Extract wikilinks from body
            wikilinks = extract_wikilinks(body)

            # Determine mtime
            mtime = datetime.fromtimestamp(stat.st_mtime, tz=_get_tz()).isoformat()

            # Build summary (first 200 chars of body) after stripping
            # markdown headings and any HTML-comment block (PR 14
            # session-rollup files carry per-turn ``<!--meta…-->``
            # blocks that are noise inside a sidebar preview).
            body_no_html = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
            body_text = re.sub(
                r"^#+\s+.*$", "", body_no_html, flags=re.MULTILINE,
            ).strip()
            summary = body_text[:200].strip() if body_text else None

            title = metadata.get("title", "")
            if not title:
                # Try to extract from first heading
                heading_match = re.search(r"^#+\s+(.+)$", body, re.MULTILINE)
                if heading_match:
                    title = heading_match.group(1).strip()
                else:
                    title = filepath.stem.replace("-", " ").replace("_", " ").title()

            tags = metadata.get("tags", [])
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",") if t.strip()]
            tags = [t.lower() for t in tags]

            # PR 14 — conversations/ files now ship session-level
            # frontmatter (``turn_count`` / ``event_ids`` / ``kinds``
            # / ``counterparts`` / ``importance_max`` / ``date_first``
            # / ``date_last``). Surface those as the per-file index
            # entry so downstream callers don't need to re-read
            # frontmatter to filter by session/counterpart/kind.
            #
            # The legacy per-turn keys (``event_id`` / ``kind`` / …)
            # don't exist on rollup files; we leave them empty there
            # so existing filters that read those fields treat
            # rollup notes as "no opinion" rather than crashing.
            session_id_meta = str(metadata.get("session_id") or "")
            turn_count = _coerce_int_meta(metadata.get("turn_count"))
            event_ids = _coerce_list_meta(metadata.get("event_ids"))
            kinds_meta = _coerce_list_meta(metadata.get("kinds"))
            counterparts = _coerce_list_meta(metadata.get("counterparts"))
            importance_max = str(metadata.get("importance_max") or "")
            date_first = str(metadata.get("date_first") or "")
            date_last = str(metadata.get("date_last") or "")

            return MemoryFileInfo(
                filename=relative,
                title=title,
                category=metadata.get("category", inferred_category),
                tags=tags,
                importance=metadata.get("importance", "medium"),
                created=metadata.get("created", mtime),
                modified=metadata.get("modified", mtime),
                source=metadata.get("source", "system"),
                char_count=len(content),
                links_to=wikilinks,
                linked_from=[],   # populated by _rebuild_link_graph
                summary=summary,
                # PR 6 per-turn dimensions — populated only for
                # legacy single-turn conversations notes. The
                # rollup files set these to "" because the dimensions
                # vary per-anchor; use the session-level fields below
                # for filtering instead.
                event_id=str(metadata.get("event_id") or ""),
                kind=str(metadata.get("kind") or ""),
                direction=str(metadata.get("direction") or ""),
                counterpart=str(metadata.get("counterpart") or ""),
                counterpart_role=str(metadata.get("counterpart_role") or ""),
                linked_event_id=str(metadata.get("linked_event_id") or ""),
                # PR 14 session-rollup aggregates.
                session_id=session_id_meta,
                turn_count=turn_count,
                event_ids=event_ids,
                kinds=kinds_meta,
                counterparts=counterparts,
                importance_max=importance_max,
                date_first=date_first,
                date_last=date_last,
            )
        except (OSError, UnicodeDecodeError) as exc:
            logger.debug("_scan_file(%s): %s", filepath, exc)
            return None

    def _list_md_files(self) -> List[Path]:
        """List all .md files in the memory directory."""
        if not self._memory_dir.exists():
            return []
        return [
            f for f in self._memory_dir.rglob("*.md")
            if f.is_file()
            and not any(part.startswith(".") or part in _SKIP_DIRS for part in f.relative_to(self._memory_dir).parts)
        ]

    def _rebuild_tag_map(self, idx: MemoryIndex) -> None:
        """Rebuild tag → filenames mapping."""
        tag_map: Dict[str, List[str]] = {}
        for filename, info in idx.files.items():
            for tag in info.tags:
                tag_lower = tag.lower()
                if tag_lower not in tag_map:
                    tag_map[tag_lower] = []
                tag_map[tag_lower].append(filename)
        idx.tag_map = tag_map

    def _rebuild_link_graph(self, idx: MemoryIndex) -> None:
        """Rebuild forward links and backlinks."""
        link_graph: Dict[str, List[str]] = {}

        # Reset all linked_from
        for info in idx.files.values():
            info.linked_from = []

        for filename, info in idx.files.items():
            resolved: list[str] = []
            for link_target in info.links_to:
                # Try to resolve wikilink to an actual file
                resolved_file = self._resolve_link(link_target, idx)
                if resolved_file:
                    resolved.append(resolved_file)

            link_graph[filename] = resolved

            # Populate backlinks
            for target in resolved:
                target_info = idx.files.get(target)
                if target_info is not None:
                    if filename not in target_info.linked_from:
                        target_info.linked_from.append(filename)

        idx.link_graph = link_graph

    def _resolve_link(self, link_target: str, idx: MemoryIndex) -> Optional[str]:
        """Resolve a wikilink target to an indexed filename."""
        slug = link_target.lower().strip()

        # 1. Exact path match (e.g. "topics/python-async")
        for filename in idx.files:
            if filename.rsplit(".", 1)[0].lower() == slug:
                return filename

        # 2. Exact stem match
        for filename in idx.files:
            stem = Path(filename).stem.lower()
            if stem == slug:
                return filename

        # 3. Strict partial match: slug ≥ 3 chars, covers ≥ 50% of stem, unique
        if len(slug) >= 3:
            candidates = []
            for filename in idx.files:
                stem = Path(filename).stem.lower()
                if slug in stem and len(slug) / len(stem) >= 0.5:
                    candidates.append(filename)
            if len(candidates) == 1:
                return candidates[0]

        return None

    def _remove_from_index(self, relative_path: str) -> None:
        """Remove a file and clean up references."""
        idx = self.index
        if relative_path in idx.files:
            del idx.files[relative_path]

        # Rebuild derived structures
        self._rebuild_tag_map(idx)
        self._rebuild_link_graph(idx)
        self._compute_totals(idx)

    def _compute_totals(self, idx: MemoryIndex) -> None:
        """Compute aggregate totals."""
        idx.total_files = len(idx.files)
        idx.total_chars = sum(f.char_count for f in idx.files.values())

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Disk persistence — hierarchical (cycle 20260503_6)
    #
    # Before: a single ``memory/_index.json`` carried every file's
    # MemoryFileInfo for the whole vault — every per-file update
    # rewrote the whole monolith, and the agent's "discover what's
    # in memory" path had to read the entire payload.
    #
    # Now: progressive disclosure across two layers.
    #
    #   memory/_index.json
    #       Root map. Tiny (1–2 KB regardless of vault size). Carries
    #       per-category aggregates, ``link_graph`` (cross-folder),
    #       and overall totals. This is what the vault-map renderer
    #       reads to build the system-prompt categories block.
    #
    #   memory/<category>/_index.json
    #       Per-folder shard. Carries the MemoryFileInfo entries and
    #       the tag_map for files inside that folder. Touched only
    #       when files in *that* category change.
    #
    # The in-memory ``MemoryIndex`` shape and every public API on
    # ``MemoryIndexManager`` are unchanged — only the on-disk
    # persistence layout changed.
    # ------------------------------------------------------------------

    def _category_dir(self, category: str) -> Path:
        """Folder that owns the per-category shard for ``category``.

        ``root`` files (no subdirectory) keep their shard at
        ``memory/_root/_index.json`` so we never collide with the
        actual root ``_index.json``.
        """
        if not category or category == "root":
            return self._memory_dir / "_root"
        return self._memory_dir / category

    def _category_index_path(self, category: str) -> Path:
        return self._category_dir(category) / _INDEX_FILE

    def _all_category_dirs(self) -> List[Path]:
        """Folders that *could* host a per-category shard. Returns
        every immediate subdirectory of ``memory/`` plus the synthetic
        ``_root/`` folder.
        """
        out: List[Path] = []
        if not self._memory_dir.exists():
            return out
        for entry in self._memory_dir.iterdir():
            if entry.is_dir() and not entry.name.startswith("_"):
                out.append(entry)
        # _root is hidden from the vault but still scanned for shards.
        root_shard = self._memory_dir / "_root"
        if root_shard.is_dir():
            out.append(root_shard)
        return out

    def _files_in_category(
        self, idx: MemoryIndex, category: str,
    ) -> Dict[str, MemoryFileInfo]:
        """Return the subset of ``idx.files`` whose category matches."""
        return {
            fn: info for fn, info in idx.files.items()
            if (info.category or "root") == category
        }

    def _tag_map_for_category(
        self, idx: MemoryIndex, files_subset: Dict[str, MemoryFileInfo],
    ) -> Dict[str, List[str]]:
        """Project ``idx.tag_map`` down to entries in ``files_subset``."""
        if not files_subset:
            return {}
        keep = set(files_subset.keys())
        out: Dict[str, List[str]] = {}
        for tag, fns in idx.tag_map.items():
            kept = [fn for fn in fns if fn in keep]
            if kept:
                out[tag] = kept
        return out

    def _load_from_disk(self) -> Optional[MemoryIndex]:
        """Load the hierarchical index back into memory.

        Strategy:
          1. Read root ``_index.json`` if present.
          2. Walk every per-category shard and merge into one
             ``MemoryIndex``.
          3. If neither exists, return ``None`` so the caller falls
             back to a full file-system rebuild.

        ``link_graph`` is sourced from the root shard when available
        (it's the canonical cross-folder view); otherwise it's
        rebuilt from each file's ``links_to``.
        """
        root_data: Dict[str, Any] = {}
        if self._index_path.exists():
            try:
                root_data = json.loads(
                    self._index_path.read_text(encoding="utf-8"),
                )
            except (json.JSONDecodeError, OSError) as exc:
                logger.debug(
                    "MemoryIndex: failed to load root _index.json: %s", exc,
                )
                root_data = {}

        idx = MemoryIndex()
        any_shard_seen = False

        for cat_dir in self._all_category_dirs():
            shard_path = cat_dir / _INDEX_FILE
            if not shard_path.exists():
                continue
            any_shard_seen = True
            try:
                shard = json.loads(shard_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                logger.debug(
                    "MemoryIndex: failed to load shard %s: %s", shard_path, exc,
                )
                continue

            for fn, raw in (shard.get("files") or {}).items():
                try:
                    info = MemoryFileInfo.from_dict(raw)
                except Exception:
                    continue
                idx.files[fn] = info
            for tag, fns in (shard.get("tag_map") or {}).items():
                bucket = idx.tag_map.setdefault(tag, [])
                for fn in fns:
                    if fn not in bucket:
                        bucket.append(fn)

        # Root-only fields fill in when the shards have populated files.
        if "link_graph" in root_data and isinstance(root_data["link_graph"], dict):
            idx.link_graph = {
                str(k): list(v) for k, v in root_data["link_graph"].items()
                if isinstance(v, list)
            }
        idx.last_rebuilt = str(root_data.get("last_rebuilt") or "")

        if not any_shard_seen and not idx.files:
            return None

        # Recompute totals so we don't trust drifted root counts.
        self._compute_totals(idx)
        if not idx.link_graph:
            self._rebuild_link_graph(idx)
        return idx

    def _save_to_disk(self) -> None:
        """Write the hierarchical index out and refresh the vault map.

        Two-phase write per (root, per-category):
          1. Each ``memory/<category>/_index.json`` gets the entries
             owned by that category plus a category-local tag_map.
          2. Root ``memory/_index.json`` gets the category aggregates,
             cross-folder ``link_graph``, and totals.

        Each file is written via tempfile + atomic rename so a crash
        mid-write never leaves a half-baked shard. Categories whose
        in-memory file set is empty have their shard removed (so
        deleted folders don't leave stale shards behind).
        """
        if self._index is None:
            return
        idx = self._index

        # Group files by category so we touch each shard exactly once.
        by_category: Dict[str, Dict[str, MemoryFileInfo]] = {}
        for info in idx.files.values():
            cat = info.category or "root"
            by_category.setdefault(cat, {})[info.filename] = info

        # Per-category shards.
        for category, files in by_category.items():
            cat_tag_map = self._tag_map_for_category(idx, files)
            shard = {
                "version": "2",
                "category": category,
                "files": {fn: info.to_dict() for fn, info in files.items()},
                "tag_map": cat_tag_map,
                "last_rebuilt": idx.last_rebuilt,
            }
            shard_path = self._category_index_path(category)
            try:
                shard_path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_json(shard_path, shard)
            except OSError as exc:
                logger.warning(
                    "MemoryIndex: failed to save shard %s: %s", shard_path, exc,
                )

        # Garbage-collect shards whose category disappeared in memory
        # (e.g. all files in ``daily-journal/`` were deleted).
        for cat_dir in self._all_category_dirs():
            cat_name = "root" if cat_dir.name == "_root" else cat_dir.name
            if cat_name in by_category:
                continue
            shard_path = cat_dir / _INDEX_FILE
            if shard_path.exists():
                try:
                    shard_path.unlink()
                except OSError:
                    pass

        # Root summary.
        categories_summary: Dict[str, Dict[str, Any]] = {}
        for category, files in by_category.items():
            total_chars = sum(int(info.char_count or 0) for info in files.values())
            last_modified = max(
                (info.modified or "" for info in files.values()),
                default="",
            )
            categories_summary[category] = {
                "file_count": len(files),
                "total_chars": total_chars,
                "last_modified": last_modified,
                "description": _CATEGORY_DESCRIPTIONS.get(category, ""),
            }

        root_doc = {
            "version": "2",
            "categories": categories_summary,
            "link_graph": idx.link_graph,
            "total_files": idx.total_files,
            "total_chars": idx.total_chars,
            "last_rebuilt": idx.last_rebuilt,
        }
        try:
            self._memory_dir.mkdir(parents=True, exist_ok=True)
            _atomic_write_json(self._index_path, root_doc)
        except OSError as exc:
            logger.warning("MemoryIndex: failed to save root _index.json: %s", exc)

        # Vault map — best-effort refresh, never blocks the index save.
        try:
            vmap = self.build_vault_map()
            _atomic_write_json(self._vault_map_path, vmap)
        except Exception:
            logger.debug(
                "MemoryIndex: vault_map refresh failed — non-critical",
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # PR 9 — Vault Map (plan §1.2 / §3.3)
    # ------------------------------------------------------------------

    def build_vault_map(self) -> Dict[str, Any]:
        """Compute the vault-map snapshot the Static Layer injects.

        Schema::

            {
              "categories": {<cat>: {"files": int, "last_modified": iso}},
              "top_tags": [[tag, count], ...],          # length ≤ 10
              "recently_modified": [
                {"filename": ..., "title": ..., "category": ...,
                 "modified": iso}, ...                  # length ≤ 5
              ],
              "memory_md_preview": "<first 200 chars or empty>",
              "total_files": int,
              "generated_at": iso,
            }

        The shape is dictated by ``MemoryContextBlock`` /
        ``Vault Map`` rendering — keep additions backwards-compatible.
        """
        idx = self.index

        # Per-category aggregate. ``description`` lets the agent
        # understand each folder's purpose from the system-prompt
        # vault map alone (cycle 20260503_6 — progressive disclosure
        # tier 1).
        categories: Dict[str, Dict[str, Any]] = {}
        for info in idx.files.values():
            cat = info.category or "root"
            slot = categories.setdefault(cat, {
                "files": 0,
                "last_modified": "",
                "description": _CATEGORY_DESCRIPTIONS.get(cat, ""),
            })
            slot["files"] += 1
            if info.modified > slot["last_modified"]:
                slot["last_modified"] = info.modified

        # Top tags
        tag_counts = sorted(
            ((t, len(files)) for t, files in idx.tag_map.items()),
            key=lambda x: -x[1],
        )[:_VAULT_MAP_TOP_TAGS]

        # Recently modified
        recent_sorted = sorted(
            idx.files.values(), key=lambda f: f.modified or "", reverse=True,
        )[:_VAULT_MAP_RECENT_LIMIT]
        recent = [
            {
                "filename": f.filename,
                "title": f.title or f.filename,
                "category": f.category or "root",
                "modified": f.modified,
            }
            for f in recent_sorted
        ]

        # MEMORY.md preview (first N chars of body, frontmatter
        # stripped). Empty when the file is absent.
        preview = ""
        memory_md = self._memory_dir / "MEMORY.md"
        if memory_md.exists():
            try:
                text = memory_md.read_text(encoding="utf-8")
                # Crude frontmatter strip — body starts after the
                # second ``---``.
                if text.startswith("---"):
                    end = text.find("\n---", 3)
                    if end > 0:
                        text = text[end + 4:]
                preview = text.strip()[:_VAULT_MAP_MEMORY_PREVIEW_CHARS]
            except OSError:
                preview = ""

        return {
            "categories": categories,
            "top_tags": tag_counts,
            "recently_modified": recent,
            "memory_md_preview": preview,
            "total_files": idx.total_files,
            "generated_at": datetime.now(_get_tz()).isoformat(),
        }

    def render_vault_map(self) -> str:
        """Render the vault map as a ~500-char markdown block ready
        for the Static Layer of the system prompt.
        """
        vmap = self.build_vault_map()
        lines: List[str] = ["## Vault Map"]
        cats = vmap.get("categories") or {}
        if cats:
            # One line per category with file count + 1-line description
            # so the agent can decide which folder to drill into next
            # without an extra tool call. Cycle 20260503_6 — progressive
            # disclosure tier 1.
            lines.append("- Categories:")
            for c, d in sorted(cats.items()):
                file_count = int(d.get("files") or 0)
                desc = (d.get("description") or "").strip()
                if desc:
                    lines.append(f"  - `{c}` ({file_count}) — {desc}")
                else:
                    lines.append(f"  - `{c}` ({file_count})")
            lines.append(
                "  Use `memory_list(category=…)` to browse a folder, "
                "`memory_read(filename=…)` for full content."
            )
        top_tags = vmap.get("top_tags") or []
        if top_tags:
            tag_summary = ", ".join(f"{t}({n})" for t, n in top_tags[:5])
            lines.append(f"- Top tags: {tag_summary}")
        recent = vmap.get("recently_modified") or []
        if recent:
            lines.append("- Recently modified:")
            for r in recent:
                lines.append(f"  - `{r['filename']}` — {r.get('title') or ''}")
        preview = vmap.get("memory_md_preview") or ""
        if preview:
            # Single-line preview for budget — full body via
            # ``memory_read("MEMORY.md")`` (plan §5.3 ladder).
            single = preview.replace("\n", " ").strip()[:200]
            lines.append(f"- MEMORY.md preview: {single}")
        return "\n".join(lines)
