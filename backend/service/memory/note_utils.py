"""Note-shape helpers shared across the host-side memory layer.

These were the module-level helpers previously living in
``service.memory.structured_writer``. After Sprint 3 + Cleanup retired
the ``StructuredMemoryWriter`` class and inlined every CRUD op into
the manager / multi-tenant managers, the helpers themselves stayed
useful — they encode Geny's host-specific note conventions
(slug shape, valid categories, wikilink syntax, linked_from
propagation) which the executor's flat-category ``NoteDraft`` /
``NotesHandle`` deliberately doesn't model.

Public surface:
    VALID_CATEGORIES      — set of category folders the host recognises
    PINNED_CATEGORY       — alias for the always-pinned facts folder
    extract_wikilinks(text) -> list[str]
    _slugify(title)       -> filesystem-safe slug
    _propagate_linked_from(provider, source_filename, targets)
                          -> async-via-run_coro_sync rewrite of every
                             linked target's frontmatter ``linked_from``
"""

from __future__ import annotations

import re
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List

logger = getLogger(__name__)


# Valid categories that map to subdirectories.
#
# Memory v2 (cf. /Geny/plan.md §1.5) categorises memory into four
# semantic groups (entities/ category was retired — counterpart info
# lives in dms/ and is derivable from conversations/ frontmatter):
#
#   * PINNED (always-inject)   — ``critical`` (Memory v2 PR 12)
#   * LEAF (source of truth)   — ``conversations`` (1 turn = 1 file)
#   * INDEX                    — ``dms`` (per-counterpart-per-day bundles)
#   * DERIVED                  — ``insights`` (LLM-distilled)
#   * CURATED                  — ``topics`` / ``projects`` / ``daily``
#   * ARTIFACT                 — ``compactions`` (s02 compactor snapshots)
#
# Membership in this set is the registration token: any category here
# is recognised by the index, search tools, and Opsidian sidebar.
VALID_CATEGORIES = {
    "critical",
    "daily", "topics", "projects", "insights",
    "dms", "conversations", "compactions",
    "executions",
    "inbox",  # whiteboard P0 — raw captures awaiting refinement
    "root",
}

# Pinned-facts category. Centralised here so the constant is the
# single source of truth shared by the manager's ``_notes_*`` helpers,
# the ``memory_pin`` tool, and the auto-promote callback wired into
# ``GenyMemoryStrategy``.
PINNED_CATEGORY = "critical"

# Maximum slug length for filenames.
_MAX_SLUG = 80


def _slugify(text: str) -> str:
    """Convert text to a filesystem-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r"[^a-z0-9가-힣\s_-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = slug.strip("-")
    return slug[:_MAX_SLUG] or "untitled"


_WIKILINK_RE = re.compile(r"\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]")


def extract_wikilinks(content: str) -> List[str]:
    """Extract ``[[wikilink]]`` targets from ``content`` (lowercased,
    deduped).
    """
    found: List[str] = []
    seen: set = set()
    for match in _WIKILINK_RE.finditer(content):
        target = match.group(1).strip().lower()
        if target and target not in seen:
            found.append(target)
            seen.add(target)
    return found


async def apropagate_linked_from(
    provider,
    source_filename: str,
    target_wikilinks: list,
) -> None:
    """For each wikilink target the source declares, append the source
    filename (sans extension) to the target's frontmatter
    ``linked_from`` list.

    Memory v2 PR 15 — closes the regression where Obsidian's Properties
    pane and external readers saw stale backlinks until the next
    reindex pass. The propagation is *immediate*: the source's first
    write triggers the rewrite of every linked target so the
    bidirectional graph is consistent before the next turn renders
    the system prompt.

    Routes the read+update through the executor's ``NotesHandle`` so
    the in-memory cache stays consistent with the on-disk
    ``linked_from`` field. Earlier revisions wrote target files
    directly with ``Path.write_text``, which bypassed the executor's
    note cache and left ``target.links_in`` empty for the rest of the
    session.

    Resolution: exact bare-stem match against ``notes.list()``, with a
    substring fallback when the wikilink doesn't match a stem
    verbatim.

    No-op when the source has no wikilinks or the provider isn't
    attached. Best-effort: if a single target rewrite fails, the
    others still go through.
    """
    if not target_wikilinks or provider is None:
        return
    from geny_executor.memory.provider import NotePatch

    notes = provider.notes()
    try:
        metas = await notes.list()
    except Exception:
        logger.debug(
            "apropagate_linked_from: provider list failed", exc_info=True,
        )
        return

    by_stem: Dict[str, str] = {}
    for m in metas:
        stem = Path(m.ref.filename).stem
        by_stem.setdefault(stem, m.ref.filename)

    source_bare = Path(source_filename).name
    source_stem = Path(source_filename).stem

    for target_link in target_wikilinks:
        link = str(target_link).strip().lower()
        if not link:
            continue
        link_stem = Path(link).stem
        bare_target = by_stem.get(link_stem)
        if bare_target is None:
            for stem, fname in by_stem.items():
                if link_stem and link_stem in stem:
                    bare_target = fname
                    break
        if bare_target is None or bare_target == source_bare:
            continue
        try:
            existing = await notes.read(bare_target)
            if existing is None:
                continue
            fm = dict(existing.frontmatter or {})
            linked = list(fm.get("linked_from") or [])
            if source_stem in linked or source_filename in linked:
                continue
            linked.append(source_stem)
            fm["linked_from"] = linked
            await notes.update(bare_target, NotePatch(frontmatter=fm))
        except Exception:
            logger.debug(
                "apropagate_linked_from: rewrite failed for %s", target_link,
                exc_info=True,
            )


def scan_dms_directory(memory_dir: Path | str) -> Dict[str, Dict[str, Any]]:
    """Deep-scan ``memory/dms/<counterpart_id>/<date>.md`` and return a
    flat ``{display_filename: file_info}`` dict.

    The ``dms/`` category uses a 2-level layout (one bundle per
    counterpart per day) which the executor's ``IndexHandle`` —
    designed for flat ``memory/<category>/<file>.md`` — cannot pick
    up. This helper does the deep walk and returns rows in the same
    shape the executor's snapshot produces, so callers (manager
    snapshot merger, ``dm_archiver._maintain_shard``) can splice them
    into the global index without the executor needing dms-specific
    awareness.

    The ``display_filename`` key uses the relative ``dms/<cp>/<date>.md``
    form so it can't collide across counterparts on the same day.
    """
    from service.memory.frontmatter import parse_frontmatter

    out: Dict[str, Dict[str, Any]] = {}
    root = Path(memory_dir) / "dms"
    if not root.exists():
        return out

    for cp_dir in sorted(root.iterdir()):
        if not cp_dir.is_dir():
            continue
        for path in sorted(cp_dir.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            try:
                meta, body = parse_frontmatter(text)
            except Exception:  # noqa: BLE001
                meta, body = {}, text
            try:
                rel = str(path.relative_to(memory_dir)).replace("\\", "/")
            except ValueError:
                rel = f"dms/{cp_dir.name}/{path.name}"
            stat = None
            try:
                stat = path.stat()
            except OSError:
                pass
            tags = meta.get("tags") or []
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",") if t.strip()]
            row: Dict[str, Any] = {
                "filename": rel,
                "title": meta.get("title") or path.stem,
                "category": "dms",
                "tags": list(tags),
                "importance": meta.get("importance") or "medium",
                "char_count": len(text),
                "links_to": list(meta.get("links_to") or []),
                "linked_from": list(meta.get("linked_from") or []),
                "summary": (
                    body.split("\n", 1)[0][:240].strip() if body.strip() else ""
                ),
                "created": meta.get("created") or "",
                "modified": meta.get("modified") or "",
                "source": "dm_bundle",
                # Counterpart-specific dimensions surfaced for index
                # consumers (Opsidian sidebar grouping, retriever).
                "counterpart": cp_dir.name,
                "counterpart_role": meta.get("counterpart_role") or "",
                "session_id": meta.get("session_id") or "",
                "event_count": int(meta.get("event_count") or 0),
                "date_first": meta.get("date_first") or "",
                "date_last": meta.get("date_last") or "",
            }
            if stat is not None and not row["modified"]:
                from datetime import datetime, timezone
                row["modified"] = datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc,
                ).isoformat()
            out[rel] = row
    return out


async def aget_index_snapshot_with_dms(
    provider, memory_dir: Path | str
) -> Dict[str, Any]:
    """One-shot helper: ``await provider.index().snapshot()`` + restore
    the ``dms/_index.json`` shard the executor clobbered + splice dms
    rows into the in-memory payload.

    The executor's ``IndexHandle.snapshot()`` (and ``.rebuild()``)
    rewrites every per-category shard from a flat ``glob("*.md")`` that
    cannot see the 2-level ``dms/<cp>/<date>.md`` layout. So even
    after ``dm_archiver`` writes a fresh shard, the *next* snapshot
    call clobbers it. This helper:

      1. Calls the executor's snapshot.
      2. Re-runs ``write_dms_shard`` so the on-disk shard is correct
         again before the next operator refresh.
      3. Splices the dms rows into the in-memory ``files`` dict so
         the returned payload reports them too (totals updated).

    Use from anywhere that needs a session-scoped index snapshot —
    ``SessionMemoryManager._index_snapshot``, controller routes, or
    any other reader. Multi-tenant managers (Global / Curated /
    UserOpsidian) don't need this — their providers don't have
    a ``dms/`` category in scope.
    """
    snap = await provider.index().snapshot()
    try:
        write_dms_shard(memory_dir)
    except Exception:
        logger.debug(
            "aget_index_snapshot_with_dms: shard restore failed",
            exc_info=True,
        )
    try:
        dms_rows = scan_dms_directory(memory_dir)
    except Exception:
        logger.debug(
            "aget_index_snapshot_with_dms: dms scan failed",
            exc_info=True,
        )
        return snap
    if not dms_rows:
        return snap
    files = dict(snap.get("files") or {})
    tag_map: Dict[str, List[str]] = {
        k: list(v) for k, v in (snap.get("tag_map") or {}).items()
    }
    total_chars = int(snap.get("total_chars", 0) or 0)
    for rel, row in dms_rows.items():
        files[rel] = row
        total_chars += int(row.get("char_count") or 0)
        for tag in row.get("tags") or []:
            tag_map.setdefault(str(tag).lower(), []).append(rel)
    out = dict(snap)
    out["files"] = files
    out["tag_map"] = tag_map
    out["total_chars"] = total_chars
    out["total_files"] = len(files)
    return out


def write_dms_shard(memory_dir: Path | str) -> None:
    """Atomically rewrite ``memory/dms/_index.json`` from a deep scan.

    Called by ``dm_archiver._append_locked`` after every bundle
    write so the operator-facing JSON shard reflects reality. The
    schema mirrors the executor's per-category shard format
    (``file_count`` / ``files`` / ``last_rebuilt`` / ``tag_counts``)
    so existing readers don't see a different shape.
    """
    import json
    import os
    import tempfile
    from datetime import datetime
    from service.utils.utils import _configured_tz as _get_tz

    files = scan_dms_directory(memory_dir)
    tag_counts: Dict[str, int] = {}
    for row in files.values():
        for tag in row.get("tags") or []:
            tag_counts[str(tag).lower()] = tag_counts.get(str(tag).lower(), 0) + 1

    payload = {
        "category": "dms",
        "description": "Per-counterpart-per-day DM index bundles.",
        "file_count": len(files),
        "files": files,
        "last_rebuilt": datetime.now(_get_tz()).isoformat(),
        "tag_counts": tag_counts,
        "version": "2",
    }
    shard_path = Path(memory_dir) / "dms" / "_index.json"
    shard_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix="_index.", suffix=".json.tmp", dir=str(shard_path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, default=str)
        os.replace(tmp, shard_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


__all__ = [
    "VALID_CATEGORIES",
    "PINNED_CATEGORY",
    "_slugify",
    "extract_wikilinks",
    "apropagate_linked_from",
    "scan_dms_directory",
    "write_dms_shard",
    "aget_index_snapshot_with_dms",
]
