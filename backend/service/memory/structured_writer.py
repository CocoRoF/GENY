"""
Structured Memory Writer — Obsidian-like note creation with frontmatter.

Builds on top of LongTermMemory's file I/O, adding:
- YAML frontmatter metadata
- Wikilink-based backlinks
- Category-based directory organisation
- Incremental index updates
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone, timedelta
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from service.memory.frontmatter import (
    build_default_metadata,
    extract_wikilinks,
    render_frontmatter,
)
from service.memory.index import MemoryIndexManager, MemoryFileInfo

logger = getLogger(__name__)

# Use configured timezone from GENY_TIMEZONE env var
from service.utils.utils import _configured_tz as _get_tz

# Valid categories that map to subdirectories.
#
# Memory v2 (cf. /Geny/plan.md §1.5) categorises memory into four
# semantic groups (entities/ category was retired — counterpart info
# lives in dms/ and is derivable from conversations/ frontmatter):
#
#   * PINNED (always-inject)   — ``critical`` (Memory v2 PR 12).
#     Holds must-know facts (호칭, persona-defining preferences,
#     binding decisions). The retriever's ``_load_pinned_facts``
#     layer reads this directory every turn regardless of query
#     so the agent never "forgets" stated user preferences.
#   * LEAF (source of truth)  — ``conversations`` (1 turn = 1 file,
#     written by ``ConversationArchiver`` not StructuredMemoryWriter).
#   * INDEX                    — ``dms`` (per-counterpart-per-day
#     bundles), and the daily journal at root level.
#   * DERIVED                  — ``insights`` (LLM-distilled).
#   * CURATED                  — ``topics``, ``projects``, ``daily``
#     (free-form notes), and the root-level ``MEMORY.md``.
#   * ARTIFACT                 — ``compactions`` (s02 compactor
#     snapshots, written by ``MemoryProvider.record_compaction``).
#
# Membership in this set is the registration token: any category here
# is recognised by the index, search tools, and Opsidian sidebar.
# StructuredMemoryWriter still only knows how to produce the 11-key
# frontmatter; extended categories (``conversations``, ``compactions``)
# carry richer frontmatter via their own dedicated writers.
#
# ``entities`` was removed — see Geny PR for the rationale. The
# auto-generated counterpart stub (formerly ``entities/<id>.md``)
# duplicated stats already in ``dms/<cp>/<date>.md`` frontmatter and
# the StreamTab UI counterpart cards. Counterpart-specific knowledge
# the user wants to curate goes to ``topics/<name>.md`` instead.
VALID_CATEGORIES = {
    "critical",
    "daily", "topics", "projects", "insights",
    "dms", "conversations", "compactions",
    "executions",
    "root",
}

# Pinned-facts category. Centralised here so the constant is the
# single source of truth shared by ``LongTermMemory.load_pinned``,
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


class StructuredMemoryWriter:
    """Structured note creation with Obsidian-like frontmatter and links.

    Usage::

        writer = StructuredMemoryWriter(memory_dir, index_manager)
        filename = writer.write_note(
            title="FastAPI 비동기 패턴",
            content="# FastAPI\\n\\n- async def 사용...",
            category="topics",
            tags=["python", "fastapi"],
        )
    """

    def __init__(
        self,
        memory_dir: str,
        index_manager: MemoryIndexManager,
        session_id: str = "",
        db_manager=None,
        memory_provider=None,
    ):
        """
        Args:
            memory_dir: Absolute path to the memory/ directory.
            index_manager: MemoryIndexManager instance for index updates.
            session_id: Session ID for metadata.
            db_manager: Optional DB manager for dual-write.
            memory_provider: Live executor `MemoryProvider`. When set,
                `write_note` / `update_note` / `delete_note` /
                `link_notes` route through `provider.notes()`; the
                legacy disk-write code stays as a fallback for
                provider-less call sites (e.g. transient unit tests
                or boot phases before AgentSession plugs the
                provider in).
        """
        self._memory_dir = Path(memory_dir)
        self._index = index_manager
        self._session_id = session_id
        self._db_manager = db_manager
        self._provider = memory_provider

    def set_memory_provider(self, provider) -> None:
        """Plug the executor `MemoryProvider` post-construction.

        AgentSession calls this once `_init_memory_provider` finishes
        — see `service.executor.agent_session._init_memory_provider`
        for the wiring. Until then `write_note` falls back to the
        legacy disk-write path so a session that boots without a
        provider (rare — only happens if the executor build fails)
        keeps working.
        """
        self._provider = provider

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    def set_database(self, db_manager, session_id: str) -> None:
        """Enable DB-backed persistence after construction."""
        self._db_manager = db_manager
        self._session_id = session_id

    # ------------------------------------------------------------------
    # Write operations
    # ------------------------------------------------------------------

    def write_note(
        self,
        title: str,
        content: str,
        *,
        category: str = "topics",
        tags: Optional[List[str]] = None,
        importance: str = "medium",
        source: str = "agent",
        links: Optional[List[str]] = None,
        filename_override: Optional[str] = None,
    ) -> str:
        """Create a new structured note with YAML frontmatter.

        With a `MemoryProvider` attached (the standard runtime path
        wired by `AgentSession._init_memory_provider`), the disk
        write goes through `provider.notes().write(NoteDraft(...))`
        — the executor handles frontmatter rendering, wikilink
        extraction, dedup, and backlink propagation. The Geny-side
        bookkeeping (operator log event, in-memory index cache,
        DB dual-write) still runs around the executor write so the
        existing retriever / vault_map / DB queries stay coherent
        during the cut-over window.

        Args:
            title: Note title.
            content: Markdown body content.
            category: Category (daily/topics/projects/insights).
            tags: List of tag strings.
            importance: low/medium/high/critical.
            source: Creation source (execution/user/agent/system/import).
            links: Explicit wikilink targets to add.
            filename_override: Override the auto-generated filename.

        Returns:
            Relative path of the created file (e.g. "topics/fastapi-async.md").
        """
        category = category if category in VALID_CATEGORIES else "topics"
        tags = [t.lower().strip() for t in (tags or []) if t.strip()]

        # Extract wikilinks from content and merge with explicit links
        auto_links = extract_wikilinks(content)
        all_links = list(set(auto_links + (links or [])))

        if self._provider is None:
            logger.warning(
                "StructuredMemoryWriter.write_note(%r): no MemoryProvider attached; "
                "skipping disk write (provider-less path was retired in PR-3g)",
                title[:60],
            )
            return ""

        relative_path, full_content, metadata = self._write_via_provider(
            title=title,
            content=content,
            category=category,
            tags=tags,
            importance=importance,
            source=source,
            all_links=all_links,
            filename_override=filename_override,
        )

        logger.info(
            "StructuredMemoryWriter: created %s (%d chars, %d tags)",
            relative_path, len(full_content), len(tags),
        )

        # Forward the write to the session-bound memory event channel
        # so it lands on the operator-facing VTuber LOGS panel. The
        # routing handles cross-session writers (curated:* / user:*)
        # gracefully — they short-circuit without an agent lookup.
        try:
            from service.memory.event_emitter import emit_memory_event
            emit_memory_event(
                self._session_id,
                event_type="note_written",
                source="Memory",
                layer="notes",
                category=category,
                importance=importance,
                path=relative_path,
                chars=len(content),
                message=(
                    f"note_written: {relative_path} "
                    f"({len(content)} chars, importance={importance})"
                ),
                extra={"tags": list(tags)} if tags else None,
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "StructuredMemoryWriter: memory_event emit skipped",
                exc_info=True,
            )

        # Update index
        self._index.update_file(relative_path)

        # Memory v2 PR 15 — propagate linked_from to wikilink targets.
        # The new note declares ``links_to: [a, b, c]`` so each of
        # those targets gains ``self`` as a back-reference. No
        # wikilink? No-op. Failure here mustn't block the write so
        # the call is best-effort.
        try:
            _propagate_linked_from(self._provider, relative_path, all_links)
        except Exception:
            logger.debug(
                "StructuredMemoryWriter: linked_from propagation failed",
                exc_info=True,
            )

        # Dual-write to DB
        self._db_write(relative_path, full_content, metadata)

        return relative_path

    # ── Internal write paths ────────────────────────────────────────

    def _write_via_provider(
        self,
        *,
        title: str,
        content: str,
        category: str,
        tags: List[str],
        importance: str,
        source: str,
        all_links: List[str],
        filename_override: Optional[str],
    ):
        """Disk write through the executor `NotesHandle`.

        The executor handles frontmatter rendering, dedup, wikilink
        extraction, and backlink propagation. We still build a
        Geny-shaped metadata dict so the DB dual-write column
        contents stay identical to the legacy path.
        """
        from geny_executor.memory.provider import (
            Importance as _ExecutorImportance,
            NoteDraft,
            Scope,
        )
        from service.memory.sync_async_bridge import run_coro_sync

        # Build the metadata that DB / event-emitter consumers expect.
        # The dict mirrors `build_default_metadata` exactly so a
        # downstream reader cannot tell whether the disk row came from
        # the legacy path or this branch.
        metadata = build_default_metadata(
            title=title,
            category=category,
            tags=tags,
            importance=importance,
            source=source,
            session_id=self._session_id,
        )
        metadata["links_to"] = list(all_links)

        # Pass Geny-specific fields (aliases, source, session_id,
        # links_to) to the executor as `frontmatter=...` so the
        # rendered .md file keeps the same superset of frontmatter
        # keys the legacy disk path produced. The executor's own
        # title/tags/category/importance/created/modified keys take
        # priority; everything else flows through verbatim.
        passthrough = {
            "aliases": metadata.get("aliases", []),
            "source": metadata.get("source", source),
            "session_id": metadata.get("session_id", self._session_id),
            "linked_from": metadata.get("linked_from", []),
            "links_to": metadata.get("links_to", []),
        }

        try:
            importance_enum = _ExecutorImportance(importance)
        except ValueError:
            importance_enum = _ExecutorImportance.MEDIUM

        # Dedup is the only piece we cannot fully delegate: the
        # executor rejects an existing filename outright when
        # `draft.filename` is set, but Geny's contract is to slip a
        # uuid suffix on the way in. Compute the override pre-flight
        # so the executor sees a unique name and never raises.
        if filename_override:
            relative_path = filename_override
        else:
            relative_path = self._make_filepath(title, category)
            candidate_path = self._memory_dir / relative_path
            if candidate_path.exists():
                relative_path = self._deduplicate(relative_path)

        # The executor's NotesHandle lives one level inside the
        # category dir — `note_dir(category) / draft.filename` is the
        # on-disk path. Pass the BARE basename here; if we hand it
        # the category-prefixed `relative_path`, the file lands at
        # `memory/<cat>/<cat>/<file>.md` and Opsidian (which scans
        # the flat layout) sees nothing.
        bare_filename = Path(relative_path).name

        draft = NoteDraft(
            title=title,
            body=content,
            category=category,
            tags=list(tags),
            importance=importance_enum,
            scope=Scope.SESSION,
            filename=bare_filename,
            frontmatter=passthrough,
        )

        meta = run_coro_sync(self._provider.notes().write(draft))
        # The executor returns a bare filename; reattach the category
        # prefix so callers downstream (index update, db dual-write,
        # operator log) keep seeing the legacy `<cat>/<file>.md` form.
        bare_returned = meta.ref.filename or bare_filename
        relative_path = (
            bare_returned if category == "root" else f"{category}/{bare_returned}"
        )

        # Re-render the metadata dict with executor-effective values
        # so downstream consumers see the row the way it actually
        # landed on disk (importance/category may have been coerced
        # by the executor's NoteDraft validation).
        metadata["category"] = meta.category or category
        metadata["importance"] = meta.importance.value
        metadata["modified"] = (
            meta.updated_at.isoformat() if meta.updated_at else metadata["modified"]
        )
        # Build the textual representation used by the DB dual-write
        # path. The same shape `render_frontmatter` produces is fine
        # because the actual on-disk write is owned by the executor.
        full_content = render_frontmatter(metadata, content)
        return relative_path, full_content, metadata

    # ── Provider-backed update / delete / link (PR-3b) ─────────────

    def _update_via_provider(
        self,
        filename: str,
        *,
        content: Optional[str],
        tags: Optional[List[str]],
        importance: Optional[str],
        category: Optional[str],
        append: bool,
    ) -> bool:
        """Update through `NotesHandle.update`. Geny tag semantics
        (merge-with-existing) are honoured by reading the current
        note first; the executor's `NotePatch.tags` is replace-only.

        Returns False when the file does not exist — matches the
        legacy contract.
        """
        from geny_executor.memory.provider import (
            Importance as _ExecutorImportance,
            NotePatch,
        )
        from service.memory.sync_async_bridge import run_coro_sync

        # Geny callers pass `<category>/<file>.md`; the executor's
        # NotesHandle keys notes by bare basename within the category
        # dir, so strip the prefix at this boundary.
        bare = Path(filename).name

        notes = self._provider.notes()
        try:
            existing = run_coro_sync(notes.read(bare))
        except Exception:  # noqa: BLE001
            logger.warning(
                "update_note: read failed via provider for %s",
                filename, exc_info=True,
            )
            return False
        if existing is None:
            logger.warning("update_note: file not found: %s", filename)
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

        body_replace = content if (content is not None and not append) else None
        body_append = content if (content is not None and append) else None

        patch = NotePatch(
            body=body_replace,
            append_body=body_append,
            tags=merged_tags,
            importance=importance_enum,
            category=category,
        )
        try:
            run_coro_sync(notes.update(bare, patch))
        except KeyError:
            logger.warning("update_note: provider missing %s", filename)
            return False
        except Exception:  # noqa: BLE001
            logger.warning(
                "update_note: provider write failed for %s",
                filename, exc_info=True,
            )
            return False

        # Geny side: keep the in-memory index cache in sync until
        # PR-3c moves IndexHandle over.
        try:
            self._index.update_file(filename)
        except Exception:  # noqa: BLE001
            logger.debug("update_note: index update skipped", exc_info=True)
        logger.debug("update_note: updated %s (via provider)", filename)
        return True

    def _delete_via_provider(self, filename: str) -> bool:
        """Delete through `NotesHandle.delete`. The executor handles
        explicit_links cleanup + cache invalidation; we only need to
        sweep the Geny in-memory index entry."""
        from service.memory.sync_async_bridge import run_coro_sync

        bare = Path(filename).name
        try:
            ok = run_coro_sync(self._provider.notes().delete(bare))
        except Exception:  # noqa: BLE001
            logger.warning(
                "delete_note: provider delete failed for %s",
                filename, exc_info=True,
            )
            return False
        if not ok:
            return False
        try:
            self._index.remove_file(filename)
        except Exception:  # noqa: BLE001
            logger.debug("delete_note: index remove skipped", exc_info=True)
        logger.info("delete_note: removed %s (via provider)", filename)
        return True

    def _link_via_provider(self, source_file: str, target_file: str) -> bool:
        """Create a `> See also: [[target]]` reference in the source
        note via `NotesHandle.update(append_body=...)`. Mirrors the
        legacy `link_notes` semantics (visible body marker, not just
        an internal explicit_links entry) so a user opening the
        source note still sees the link in Obsidian.
        """
        from geny_executor.memory.provider import NotePatch
        from service.memory.sync_async_bridge import run_coro_sync

        target_stem = Path(target_file).stem
        bare_source = Path(source_file).name
        notes = self._provider.notes()

        try:
            existing = run_coro_sync(notes.read(bare_source))
        except Exception:  # noqa: BLE001
            logger.warning(
                "link_notes: read failed via provider for %s",
                source_file, exc_info=True,
            )
            return False
        if existing is None:
            return False

        # Idempotency — same as legacy.
        marker = f"[[{target_stem}]]"
        if marker.lower() in existing.body.lower():
            return True
        if target_stem in (existing.links_out or []):
            return True

        patch = NotePatch(append_body=f"> See also: {marker}")
        try:
            run_coro_sync(notes.update(bare_source, patch))
        except KeyError:
            return False
        except Exception:  # noqa: BLE001
            logger.warning(
                "link_notes: provider update failed for %s → %s",
                source_file, target_stem, exc_info=True,
            )
            return False

        try:
            self._index.update_file(source_file)
            self._index.update_file(target_file)
        except Exception:  # noqa: BLE001
            logger.debug("link_notes: index update skipped", exc_info=True)
        return True

    def update_note(
        self,
        filename: str,
        *,
        content: Optional[str] = None,
        tags: Optional[List[str]] = None,
        importance: Optional[str] = None,
        category: Optional[str] = None,
        append: bool = False,
    ) -> bool:
        """Update an existing note's content and/or metadata.

        Args:
            filename: Relative path within memory_dir.
            content: New body content (or content to append).
            tags: Tags to add (merged with existing).
            importance: New importance level.
            append: If True, append content instead of replacing.

        Returns:
            True if the file was successfully updated.
        """
        if self._provider is None:
            logger.warning(
                "StructuredMemoryWriter.update_note(%s): no MemoryProvider attached",
                filename,
            )
            return False
        return self._update_via_provider(
            filename,
            content=content,
            tags=tags,
            importance=importance,
            category=category,
            append=append,
        )

    def delete_note(self, filename: str) -> bool:
        """Delete a note and remove from index.

        Args:
            filename: Relative path within memory_dir.

        Returns:
            True if deleted.
        """
        if self._provider is None:
            logger.warning(
                "StructuredMemoryWriter.delete_note(%s): no MemoryProvider attached",
                filename,
            )
            return False
        return self._delete_via_provider(filename)

    def link_notes(self, source_file: str, target_file: str) -> bool:
        """Create a bidirectional link between two notes.

        Adds ``[[target]]`` reference to source file and updates backlinks.

        Args:
            source_file: Source note filename.
            target_file: Target note filename.

        Returns:
            True if link was created.
        """
        if self._provider is None:
            logger.warning(
                "StructuredMemoryWriter.link_notes(%s→%s): no MemoryProvider attached",
                source_file, target_file,
            )
            return False
        return self._link_via_provider(source_file, target_file)

    def read_note(self, filename: str) -> Optional[Dict[str, Any]]:
        """Read a note via `NotesHandle.read` and return the legacy
        Geny dict shape (`filename`, `title`, `metadata`, `body`,
        `raw`, `links_to`, `linked_from`) for caller compatibility.
        """
        if self._provider is None:
            logger.debug(
                "read_note(%s): no MemoryProvider attached", filename,
            )
            return None
        from service.memory.sync_async_bridge import run_coro_sync

        bare = Path(filename).name
        try:
            note = run_coro_sync(self._provider.notes().read(bare))
        except Exception:  # noqa: BLE001
            logger.debug(
                "read_note(%s): provider read failed",
                filename, exc_info=True,
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
            "raw": "",  # executor owns the rendered file; raw text rebuilt on demand
            "links_to": list(note.links_out),
            "linked_from": list(note.links_in),
        }

    def list_notes(
        self,
        *,
        category: Optional[str] = None,
        tag: Optional[str] = None,
        importance: Optional[str] = None,
    ) -> List[MemoryFileInfo]:
        """List notes with optional filtering.

        Returns Geny-shaped `MemoryFileInfo` objects. With a provider
        attached the listing goes through `NotesHandle.list` and is
        adapted into MemoryFileInfo so callers (controllers, tools,
        retriever vault map) keep their existing iteration code.
        """
        if self._provider is None:
            return []
        from geny_executor.memory.provider import Importance as _Importance
        from service.memory.sync_async_bridge import run_coro_sync

        importance_filter = None
        if importance:
            try:
                importance_filter = _Importance(importance)
            except ValueError:
                importance_filter = None
        try:
            metas = run_coro_sync(
                self._provider.notes().list(
                    category=category,
                    tag=tag,
                    importance=importance_filter,
                )
            )
        except Exception:  # noqa: BLE001
            logger.debug("list_notes: provider list failed", exc_info=True)
            metas = []
        results: List[MemoryFileInfo] = []
        for m in metas:
            cat = m.category or "root"
            bare = m.ref.filename
            display_filename = bare if cat == "root" else f"{cat}/{bare}"
            results.append(MemoryFileInfo(
                filename=display_filename,
                title=m.title or bare,
                category=cat,
                tags=list(m.tags),
                importance=m.importance.value,
                created=m.created_at.isoformat() if m.created_at else "",
                modified=m.updated_at.isoformat() if m.updated_at else "",
                source="system",
                char_count=m.size_bytes,
                links_to=[],
                linked_from=[],
            ))
        results.sort(key=lambda f: f.modified, reverse=True)
        return results

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _make_filepath(self, title: str, category: str) -> str:
        """Generate a relative file path from title and category."""
        slug = _slugify(title)
        if category == "root":
            return f"{slug}.md"
        return f"{category}/{slug}.md"

    def _deduplicate(self, path: str) -> str:
        """Add numeric suffix if path already exists."""
        base, ext = os.path.splitext(path)
        counter = 1
        while (self._memory_dir / f"{base}-{counter}{ext}").exists():
            counter += 1
        return f"{base}-{counter}{ext}"

    def _infer_category(self, filename: str) -> str:
        """Infer category from directory name."""
        parts = filename.replace("\\", "/").split("/")
        if len(parts) > 1 and parts[0] in VALID_CATEGORIES:
            return parts[0]
        return "root"

    def _db_write(self, filename: str, content: str, metadata: Dict[str, Any]) -> None:
        """Dual-write to database (non-critical)."""
        if self._db_manager is None or not self._session_id:
            return
        try:
            import json
            import uuid
            from service.database.memory_db_helper import _get_db_manager, _is_db_available

            if not _is_db_available(self._db_manager):
                return

            mgr = _get_db_manager(self._db_manager)
            entry_id = str(uuid.uuid4())
            now = datetime.now(_get_tz()).isoformat()
            tags_json = json.dumps(metadata.get("tags", []), ensure_ascii=False)
            category = metadata.get("category", "topics")
            importance = metadata.get("importance", "medium")
            links_json = json.dumps(metadata.get("links_to", []), ensure_ascii=False)

            query = (
                "INSERT INTO session_memory_entries "
                "(entry_id, session_id, source, entry_type, content, filename, "
                "heading, topic, metadata_json, entry_timestamp, "
                "category, tags_json, importance, links_to_json, source_type) "
                "VALUES (%s, %s, 'long_term', %s, %s, %s, %s, %s, %s, %s, "
                "%s, %s, %s, %s, %s) "
                "RETURNING id"
            )
            params = (
                entry_id, self._session_id,
                category,  # entry_type = category
                content,
                f"memory/{filename}",
                metadata.get("title", ""),
                "",  # topic
                json.dumps(metadata, ensure_ascii=False, default=str),
                now,
                category,
                tags_json,
                importance,
                links_json,
                metadata.get("source", "system"),
            )
            mgr.execute_insert(query, params)
        except Exception as exc:
            logger.debug("StructuredMemoryWriter: DB write failed (non-critical): %s", exc)


# ─────────────────────────────────────────────────────────────────
# Module-level helpers (Memory v2 PR 15)
# ─────────────────────────────────────────────────────────────────


def _propagate_linked_from(
    provider,
    source_filename: str,
    target_wikilinks: list,
) -> None:
    """For each wikilink target the source declares, append the source
    filename (sans extension) to the target's frontmatter
    ``linked_from`` list.

    Memory v2 PR 15 — closes review.md P11 (frontmatter linked_from
    out of sync with _index.json). The propagation is *immediate*
    so Obsidian's Properties pane and external readers see backlinks
    without waiting for a reindex.

    Routes the read+update through the executor's `NotesHandle` so
    the in-memory cache stays consistent with the on-disk
    ``linked_from`` field. Earlier revisions wrote target files
    directly with `Path.write_text`, which bypassed the executor's
    note cache and left `target.links_in` empty for the rest of the
    session.

    Resolution: exact bare-stem match against `notes.list()`, with a
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
