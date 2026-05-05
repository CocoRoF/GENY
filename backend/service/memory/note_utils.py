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


def _propagate_linked_from(
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
    from service.memory.sync_async_bridge import run_coro_sync

    notes = provider.notes()
    try:
        metas = run_coro_sync(notes.list())
    except Exception:
        logger.debug(
            "_propagate_linked_from: provider list failed", exc_info=True,
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
            existing = run_coro_sync(notes.read(bare_target))
            if existing is None:
                continue
            fm = dict(existing.frontmatter or {})
            linked = list(fm.get("linked_from") or [])
            if source_stem in linked or source_filename in linked:
                continue
            linked.append(source_stem)
            fm["linked_from"] = linked
            run_coro_sync(notes.update(bare_target, NotePatch(frontmatter=fm)))
        except Exception:
            logger.debug(
                "_propagate_linked_from: rewrite failed for %s", target_link,
                exc_info=True,
            )


__all__ = [
    "VALID_CATEGORIES",
    "PINNED_CATEGORY",
    "_slugify",
    "extract_wikilinks",
    "_propagate_linked_from",
]
