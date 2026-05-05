"""DM bundle index writer — Memory v2 PR 4.

Per-counterpart-per-day index bundle at
``memory/dms/<sanitized_counterpart>/<YYYY-MM-DD>.md`` (cf. plan
§1.7). Body is a chronologically-sorted list of one-line headlines,
each pointing at its leaf-of-truth ``conversations/<id>.md`` via a
wikilink. Frontmatter accumulates ``event_count`` and the
``event_ids`` list so the existing index manager can find the
bundle by counterpart filter.

This is **append-shaped**: every new DM-class turn for a known
``(counterpart, date)`` reads the existing bundle, appends a new
turn block, and rewrites the file. The lock on
``ConversationArchiver`` does not cover this — hence a separate
``RLock`` on the bundle path.

Why not a single bundle file per day across counterparts: the
existing Stream tab already groups events by counterpart, the
``memory_with`` tool filters by counterpart, and the per-counterpart
``insights/counterpart-<id>.md`` distillation (when the agent
chooses to write one) wants to ``[[wikilink]]`` to the matching
dms bundle. A counterpart-keyed layout makes those three consumers'
lookup O(1).

Why this archiver does **not** route through the executor's
``NotesHandle``: the executor's ``FileMemoryProvider`` keys notes
by bare basename within the category dir (``memory/<cat>/<file>.md``)
and only ``mkdir(parents=True)`` for the category dir itself. The
``dms/<cp>/<date>.md`` two-level layout would either collide (same
``<date>.md`` across counterparts) or fail to write (missing parent
``<cp>/`` directory). The per-counterpart subdir is a Geny business
choice that doesn't fit the flat-category contract, so dms keeps
its own atomic-write path.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, tzinfo
from pathlib import Path
from typing import Any, Dict, List, Optional

from service.memory.conversation_archiver import (
    sanitize_counterpart,
    short_event_id,
)
from service.memory.frontmatter import parse_frontmatter, render_frontmatter
from service.memory.interaction_event import (
    Direction,
    InteractionEventView,
    Kind,
    parse_event_metadata,
)
from service.utils.utils import _configured_tz as _get_tz

logger = logging.getLogger(__name__)


CATEGORY = "dms"

#: Kinds that warrant a dms bundle entry. Mirror of
#: ``conversation_archiver._DM_KINDS`` so the two writers stay
#: synchronised — every conversation that gets a ``dms/<cp>/<date>``
#: wikilink in its ``links_to`` also lands in the bundle here.
_DM_KINDS = frozenset({
    Kind.DM.value,
    Kind.TASK_REQUEST.value,
    Kind.TASK_RESULT.value,
    Kind.TOOL_RUN_SUMMARY.value,
})

#: Counterparts that don't represent an external party — never get
#: a bundle file (an agent's reflection isn't a "DM with self").
_SKIP_COUNTERPARTS = frozenset({"self", "system", "", "unknown"})


@dataclass(frozen=True)
class DmBundleUpdate:
    """Result of a successful :meth:`DmArchiver.append`."""

    relative_path: str   # e.g. "dms/82b10c90/2026-05-01.md"
    absolute_path: str
    event_count: int     # post-append count


class DmArchiver:
    """Writer for ``memory/dms/<sanitized_counterpart>/<date>.md``."""

    CATEGORY = CATEGORY

    def __init__(
        self,
        memory_dir: str,
        *,
        session_id: str = "",
        tz: Optional[tzinfo] = None,
    ) -> None:
        self._memory_dir = Path(memory_dir)
        self._session_id = session_id
        self._tz = tz or _get_tz()
        import threading
        # One lock per archiver — protects the read-modify-write of
        # ``dms/<cp>/<date>.md``. RLock so unit tests using a fake
        # writer that re-enters can't deadlock.
        self._lock = threading.RLock()
        # Sprint 3 step 4 — host-side index_manager parameter retired;
        # ``dms/`` rollups stay on direct atomic-write but the executor
        # picks up newly-written files via its bare-basename scanner
        # on the next IndexHandle.snapshot() / .rebuild() pass.

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    @property
    def dms_dir(self) -> Path:
        return self._memory_dir / CATEGORY

    def append(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]],
        conversation_ref: Optional[str] = None,
    ) -> Optional[DmBundleUpdate]:
        """Append one turn entry to the daily bundle for this
        counterpart, creating the bundle if absent.

        Returns ``None`` on skip (legacy metadata / non-DM kind /
        self-counterpart / write error). Never raises — caller
        treats None as "this turn doesn't belong in dms/".
        """
        view = parse_event_metadata(metadata)
        if view is None:
            return None
        if view.kind not in _DM_KINDS:
            return None
        cp_id = (view.counterpart_id or "").strip()
        if cp_id in _SKIP_COUNTERPARTS:
            return None
        try:
            return self._append_locked(role, content, view, conversation_ref)
        except Exception:
            logger.debug(
                "dm_archiver: append failed — non-critical",
                exc_info=True,
            )
            return None

    # ── internal ─────────────────────────────────────────────────

    def _append_locked(
        self,
        role: str,
        content: str,
        view: InteractionEventView,
        conversation_ref: Optional[str],
    ) -> Optional[DmBundleUpdate]:
        ts = self._resolve_ts(view.metadata)
        date = ts.date().isoformat()
        cp_safe = sanitize_counterpart(view.counterpart_id or "unknown")
        rel_path = f"{CATEGORY}/{cp_safe}/{date}.md"
        abs_path = self._memory_dir / rel_path

        # The dms layout — `memory/dms/<cp>/<date>.md` — has a
        # counterpart subdirectory inside the category. The
        # executor's NotesHandle keys notes by bare basename within
        # `memory/<category>/`, so a 2-level subpath like this would
        # collide across counterparts on the same day. dms rollup
        # stays on the direct atomic-write path; the per-counterpart
        # directory is a Geny business choice that doesn't fit
        # NotesHandle's flat-category contract.
        with self._lock:
            existing_meta, existing_body = self._load_or_init(
                abs_path, view, date, cp_safe,
            )
            # Append the new turn block to the body, drop the trailing
            # boundary if present so we always re-render cleanly.
            entry = self._render_entry(view, ts, role, content, conversation_ref)
            new_body = (existing_body.rstrip() + "\n\n" + entry).strip() + "\n"
            new_meta = self._update_meta(existing_meta, view, ts, conversation_ref)
            full_text = render_frontmatter(new_meta, new_body)
            try:
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                abs_path.write_text(full_text, encoding="utf-8")
            except OSError as exc:
                logger.warning(
                    "dm_archiver: write failed for %s: %s",
                    abs_path, exc,
                )
                return None
            # Refresh ``dms/_index.json`` ourselves. The executor's
            # IndexHandle uses a flat ``memory/<cat>/*.md`` glob that
            # cannot see the 2-level ``dms/<cp>/<date>.md`` layout, so
            # without this maintenance step the dms shard stays at
            # bootstrap (file_count=0, files={}) forever even though
            # bundles are being written. The Sprint 3 step 4 comment
            # below was incorrect — the executor never sees these
            # files, so we own the shard.
            try:
                from service.memory.note_utils import write_dms_shard
                write_dms_shard(self._memory_dir)
            except Exception:
                logger.debug(
                    "dm_archiver: dms shard refresh failed",
                    exc_info=True,
                )
            return DmBundleUpdate(
                relative_path=rel_path,
                absolute_path=str(abs_path),
                event_count=int(new_meta.get("event_count", 0)),
            )

    def _resolve_ts(self, metadata: Dict[str, Any]) -> datetime:
        raw = metadata.get("ts")
        if isinstance(raw, str) and raw:
            try:
                parsed = datetime.fromisoformat(raw)
                return (
                    parsed.astimezone(self._tz)
                    if parsed.tzinfo
                    else parsed.replace(tzinfo=self._tz)
                )
            except ValueError:
                pass
        return datetime.now(self._tz)

    def _load_or_init(
        self,
        abs_path: Path,
        view: InteractionEventView,
        date: str,
        cp_safe: str,
    ) -> tuple[Dict[str, Any], str]:
        """Read existing bundle frontmatter + body, or build a fresh
        skeleton when the file is absent.
        """
        if abs_path.exists():
            try:
                text = abs_path.read_text(encoding="utf-8")
                meta, body = parse_frontmatter(text)
                if meta:
                    # ensure event_ids is a list (parser may degrade
                    # to comma-string when frontmatter was hand-edited)
                    eids = meta.get("event_ids")
                    if isinstance(eids, str):
                        meta["event_ids"] = [
                            e.strip() for e in eids.split(",") if e.strip()
                        ]
                    elif not isinstance(eids, list):
                        meta["event_ids"] = []
                    return meta, body
            except OSError as exc:
                logger.debug(
                    "dm_archiver: read failed for %s: %s — re-initialising",
                    abs_path, exc,
                )
        # Fresh bundle skeleton
        cp_role = (view.counterpart_role or "").strip()
        title_role = f"{cp_role} " if cp_role else ""
        title = f"DM with {title_role}({cp_safe})".strip()
        meta = {
            "title": title,
            "category": CATEGORY,
            "counterpart": view.counterpart_id or "",
            "counterpart_role": cp_role,
            "date": date,
            "tags": ["dms", cp_role] if cp_role else ["dms"],
            "importance": "medium",
            "event_count": 0,
            "event_ids": [],
            "session_id": self._session_id,
            "links_to": [],
            "linked_from": [],
        }
        body = f"# {date} — DM bundle ({cp_safe})\n"
        return meta, body

    def _update_meta(
        self,
        meta: Dict[str, Any],
        view: InteractionEventView,
        ts: datetime,
        conversation_ref: Optional[str],
    ) -> Dict[str, Any]:
        new_meta = dict(meta)
        eids = list(new_meta.get("event_ids") or [])
        if view.event_id and view.event_id not in eids:
            eids.append(view.event_id)
        new_meta["event_ids"] = eids
        new_meta["event_count"] = len(eids)
        # Bump links_to with the new conversation_ref if known —
        # keeps the bundle's wikilinks in sync with body content
        # (Obsidian "Linked references" pane reads frontmatter too).
        links = list(new_meta.get("links_to") or [])
        if conversation_ref:
            ref_no_ext = conversation_ref[:-3] if conversation_ref.endswith(".md") else conversation_ref
            if ref_no_ext not in links:
                links.append(ref_no_ext)
        new_meta["links_to"] = links
        new_meta["modified"] = ts.isoformat()
        return new_meta

    @staticmethod
    def _render_entry(
        view: InteractionEventView,
        ts: datetime,
        role: str,
        content: str,
        conversation_ref: Optional[str],
    ) -> str:
        """Render one turn block — heading line + 1-line body
        excerpt + wikilink to the conversations/ leaf.
        """
        arrow = (
            "→" if view.direction == Direction.OUT.value
            else "←" if view.direction == Direction.IN.value
            else "·"
        )
        time_str = ts.strftime("%H:%M:%S")
        # First non-empty line of content as an excerpt; bounded so
        # the bundle stays index-shaped (no body duplication).
        excerpt = ""
        for line in (content or "").splitlines():
            line = line.strip()
            if line:
                excerpt = line[:140]
                if len(line) > 140:
                    excerpt = excerpt.rstrip() + "…"
                break
        lines = [f"## {time_str} · {view.kind} {arrow} {view.direction}"]
        if excerpt:
            lines.append(f"> {excerpt}")
        if conversation_ref:
            ref_target = conversation_ref[:-3] if conversation_ref.endswith(".md") else conversation_ref
            lines.append(f"[[{ref_target}|→ 본문]]")
        # Optional event_id breadcrumb for the operator who
        # cross-references stream tab event ids.
        eid_short = short_event_id(view.event_id, width=8)
        lines.append(f"_event_id: `{eid_short}`_")
        return "\n".join(lines)


__all__ = [
    "CATEGORY",
    "DmArchiver",
    "DmBundleUpdate",
]
