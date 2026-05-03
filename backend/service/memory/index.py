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
                # File removed — delete from index
                self._remove_from_index(relative_path)
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

    def _load_from_disk(self) -> Optional[MemoryIndex]:
        """Load index from _index.json."""
        if not self._index_path.exists():
            return None
        try:
            data = json.loads(self._index_path.read_text(encoding="utf-8"))
            return MemoryIndex.from_dict(data)
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            logger.debug("MemoryIndex: failed to load _index.json: %s", exc)
            return None

    def _save_to_disk(self) -> None:
        """Save index to _index.json AND refresh _vault_map.json.

        Memory v2 PR 9 — the vault map is a ~500-char "table of
        contents" the system prompt's Static Layer injects in place
        of MEMORY.md body (plan §1.2). It is purely derived from
        the index — recomputed from scratch on every save so a
        stale value cannot survive a rebuild.
        """
        if self._index is None:
            return
        try:
            self._memory_dir.mkdir(parents=True, exist_ok=True)
            data = json.dumps(self._index.to_dict(), ensure_ascii=False, indent=2)
            self._index_path.write_text(data, encoding="utf-8")
        except OSError as exc:
            logger.warning("MemoryIndex: failed to save _index.json: %s", exc)
        # Best-effort vault map refresh — never blocks the index
        # save from being acknowledged.
        try:
            vmap = self.build_vault_map()
            self._vault_map_path.write_text(
                json.dumps(vmap, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
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

        # Per-category aggregate
        categories: Dict[str, Dict[str, Any]] = {}
        for info in idx.files.values():
            cat = info.category or "root"
            slot = categories.setdefault(cat, {"files": 0, "last_modified": ""})
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
            cat_summary = ", ".join(
                f"{c}({d['files']})" for c, d in sorted(cats.items())
            )
            lines.append(f"- Categories: {cat_summary}")
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
