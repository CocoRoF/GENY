"""Conversation archiver — Memory v2 leaf source-of-truth writer.

Memory v2 (cf. ``/Geny/plan.md`` §1.6) makes ``memory/conversations/``
the **leaf source of truth** for every turn the agent records: one
file per turn, full body verbatim, canonical 13-key frontmatter.
Other categories (``dms/``, the daily journal at root,
``entities/``) are *index bundles* that point into ``conversations/``
via wikilinks rather than carrying body content of their own.

This module owns the writer for that single category. It does **not**:

  * call ``record_message`` itself (the manager calls *this* in PR 2);
  * touch ``StructuredMemoryWriter`` (whose 11-key frontmatter is too
    narrow for InteractionEvent metadata);
  * mutate the ``_index.json`` cache directly (the index manager
    rescans all categories on its own schedule).

Design contract (every PR downstream depends on this):

  1. **One turn = one file.** ``archive`` writes exactly one file per
     valid InteractionEvent. Returns the relative path on success or
     ``None`` when metadata is missing the canonical 5 keys (legacy
     line, see ``parse_event_metadata``).
  2. **Filename is deterministic** —
     ``conversations/<YYYY-MM-DD>/<HH-MM-SS>__<role>__<eid8>.md``.
     Sub-second collisions widen ``eid8`` → ``eid12`` (and beyond)
     until uniqueness is achieved.
  3. **Frontmatter has 17 keys** — the 13 canonical InteractionEvent
     dimensions plus ``tags / importance / links_to / linked_from``
     so the existing index manager and Obsidian both round-trip
     correctly.
  4. **Body never truncates.** The whole content is preserved
     verbatim regardless of length; truncation is only legal for the
     STM jsonl mirror (PR 2 keeps that cap).
  5. **Importance is computed, not asked.** Callers don't pass
     importance; the writer infers it from kind + payload. See
     :func:`compute_importance`.

Why a class rather than a free function: the writer holds a per-
session ``memory_dir`` and ``tz``, and exposes test seams (lock,
clock) that the integration suite needs. Keeping that state on an
instance makes it trivial to swap in a fake in unit tests.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, tzinfo
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from service.memory.frontmatter import render_frontmatter
from service.memory.interaction_event import (
    Direction,
    InteractionEventView,
    Kind,
    parse_event_metadata,
)
from service.utils.utils import _configured_tz as _get_tz

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────

#: Top-level category slug. Must match the entry in
#: ``service.memory.structured_writer.VALID_CATEGORIES``.
CATEGORY = "conversations"

#: Default short-event-id width used in filenames. Plan §1.6.1
#: chose 8 hex chars ≈ 4 billion namespace per (date, second, role)
#: bucket which is more than enough; collisions trigger ``_widen``
#: to expand the prefix.
EID_WIDTH_DEFAULT = 8
EID_WIDTH_MAX = 32  # full uuid hex

#: Counterpart ids that don't represent an external party — wikilinks
#: to ``entities/<x>`` and ``dms/<x>`` are not generated for these.
_SELF_LIKE_COUNTERPARTS = frozenset({"self", "system", "", "unknown"})

#: Kinds that warrant a ``dms/<cp>/<date>`` wikilink in
#: ``links_to``. Mirrors the kind set the dm_archiver in PR 4 will
#: use for index bundling.
_DM_KINDS = frozenset({
    Kind.DM.value,
    Kind.TASK_REQUEST.value,
    Kind.TASK_RESULT.value,
    Kind.TOOL_RUN_SUMMARY.value,
})

#: Sanitiser for counterpart ids when used as path / filename
#: components. Mirrors the helper inside ``entity_bootstrap`` so the
#: two writers reach identical disk paths for the same counterpart.
_PATH_SAFE_RE = re.compile(r"[^A-Za-z0-9_\-]")

#: Heuristic thresholds for :func:`compute_importance`. Plan
#: §1.6.4 — pinned constants here so unit tests can import them
#: instead of magic numbers.
LONG_BODY_THRESHOLD = 5_000
SHORT_BODY_THRESHOLD = 50

#: Title prefix length for non-payload kinds. Body's first non-empty
#: line is summarised down to this many chars in the frontmatter
#: ``title``. Index manager / Obsidian Properties / Vault Map all
#: read this — keep it tight.
TITLE_PREFIX_CHARS = 80


# ─────────────────────────────────────────────────────────────────
# Public dataclass
# ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ArchivedConversation:
    """Result of a successful :meth:`ConversationArchiver.archive` call.

    Returned to callers (``record_message`` in PR 2) so they can
    stamp ``payload.conversation_ref`` on the STM jsonl line — this
    is the pointer the Stream tab follows when an operator clicks
    an event row.
    """

    relative_path: str   # e.g. "conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45.md"
    absolute_path: str
    importance: str
    event_id: str


# ─────────────────────────────────────────────────────────────────
# Importance heuristic (plan §1.6.4)
# ─────────────────────────────────────────────────────────────────


def compute_importance(
    *,
    kind: str,
    content_chars: int,
    payload: Optional[Dict[str, Any]],
) -> str:
    """Map a turn to ``low | medium | high | critical``.

    The rules (plan §1.6.4):

      * ``critical`` — ``kind == system_note`` AND payload reports
        at least one error.
      * ``high``     — ``kind == task_result`` AND files_written≥1,
                      OR content_chars > 5000,
                      OR payload reports errors.
      * ``low``      — ``kind ∈ {reflection, internal_trigger}`` or
                      content_chars < 50.
      * ``medium``   — anything else (the default for user_chat,
                      dm, task_request, tool_run_summary).

    Lower-precedence rules are checked last so the ladder is stable
    when multiple rules apply (e.g. a 6000-char reflection still
    flags as ``high`` for the long body, not ``low``).
    """
    payload = payload or {}
    errors = payload.get("errors") or []
    files_written = payload.get("files_written") or []
    has_errors = bool(errors)

    if kind == Kind.SYSTEM_NOTE.value and has_errors:
        return "critical"

    if kind == Kind.TASK_RESULT.value and len(files_written) >= 1:
        return "high"
    if content_chars > LONG_BODY_THRESHOLD:
        return "high"
    if has_errors:
        return "high"

    if kind in (Kind.REFLECTION.value, "internal_trigger"):
        return "low"
    if content_chars < SHORT_BODY_THRESHOLD:
        return "low"

    return "medium"


# ─────────────────────────────────────────────────────────────────
# Filename / id helpers
# ─────────────────────────────────────────────────────────────────


def sanitize_counterpart(counterpart_id: str) -> str:
    """Strip a counterpart id to a path-safe slug.

    Same algorithm as ``entity_bootstrap._sanitize_counterpart_for_filename``
    so the two writers produce matching wikilink targets. Owner ids
    like ``owner:gkfua00`` collapse to ``owner_gkfua00``; UUIDs stay
    intact (already path-safe).
    """
    cleaned = _PATH_SAFE_RE.sub("_", counterpart_id or "unknown")
    return cleaned[:80] or "unknown"


def short_event_id(event_id: str, *, width: int = EID_WIDTH_DEFAULT) -> str:
    """Truncate a uuid hex to ``width`` chars. ``width`` is clamped
    to ``[1, EID_WIDTH_MAX]`` so callers can't accidentally produce
    an empty or oversized prefix.
    """
    eid = (event_id or "").strip()
    if not eid:
        eid = "00000000"
    return eid[: max(1, min(EID_WIDTH_MAX, width))]


def filename_for(
    *,
    ts: datetime,
    role: str,
    event_id: str,
    eid_width: int = EID_WIDTH_DEFAULT,
) -> Tuple[str, str]:
    """Return ``(date_subdir, filename)`` for a turn.

    Filename shape: ``<HH-MM-SS>__<role>__<eid_width-char eid>.md``.
    The date subdir is the ISO date of ``ts`` in its native tz.
    """
    safe_role = _PATH_SAFE_RE.sub("_", role or "unknown") or "unknown"
    date = ts.date().isoformat()
    name = (
        f"{ts.strftime('%H-%M-%S')}__{safe_role}__"
        f"{short_event_id(event_id, width=eid_width)}.md"
    )
    return date, name


# ─────────────────────────────────────────────────────────────────
# Frontmatter / body builders
# ─────────────────────────────────────────────────────────────────


def build_title(
    *,
    kind: str,
    direction: str,
    counterpart_id: Optional[str],
    content: str,
) -> str:
    """Compose a one-line title for the frontmatter.

    Keep it informative but bounded: the index manager sources
    ``MemoryFileInfo.title`` from this and the Vault Map / Obsidian
    Properties view truncate at their own widths.
    """
    arrow = _direction_arrow(direction)
    cp_short = (counterpart_id or "")[:8] if counterpart_id else ""
    cp_part = f" {arrow} {cp_short}" if cp_short else ""
    prefix = f"[{kind}{cp_part}]"

    body_head = ""
    for line in (content or "").splitlines():
        line = line.strip()
        if line:
            body_head = line[:TITLE_PREFIX_CHARS]
            if len(line) > TITLE_PREFIX_CHARS:
                body_head = body_head.rstrip() + "…"
            break

    if body_head:
        return f"{prefix} {body_head}"
    return prefix


def _direction_arrow(direction: str) -> str:
    if direction == Direction.OUT.value:
        return "→"
    if direction == Direction.IN.value:
        return "←"
    return "·"


def build_links_to(
    *,
    kind: str,
    counterpart_id: Optional[str],
    date: str,
) -> List[str]:
    """Compute the standard wikilink targets for a conversations note.

    Plan §1.6.2 — every conversations/ note links *up* to the day
    journal, the counterpart entity, and (for DM-class kinds) the
    dms/ daily bundle. tool_run_summary's ``linked_event_id``
    pointer is rendered separately in the body.
    """
    out: List[str] = [date]  # always link to the daily journal
    cp_id = (counterpart_id or "").strip()
    if cp_id and cp_id not in _SELF_LIKE_COUNTERPARTS:
        cp_safe = sanitize_counterpart(cp_id)
        out.append(f"entities/{cp_safe}")
        if kind in _DM_KINDS:
            out.append(f"dms/{cp_safe}/{date}")
    return out


def build_tags(*, kind: str, counterpart_role: Optional[str]) -> List[str]:
    """Standard tag set: ``conversation`` always, then kind, then
    counterpart_role (if any). Matches plan §1.6.2 example.
    """
    tags = ["conversation", kind]
    if counterpart_role:
        tags.append(counterpart_role)
    # Lower-cased to match index manager normalisation.
    return [t.lower() for t in tags if t]


def build_frontmatter(
    *,
    title: str,
    ts: datetime,
    event_id: str,
    role: str,
    kind: str,
    direction: str,
    counterpart_id: Optional[str],
    counterpart_role: Optional[str],
    linked_event_id: Optional[str],
    session_id: str,
    content_chars: int,
    importance: str,
    tags: Iterable[str],
    links_to: Iterable[str],
) -> Dict[str, Any]:
    """Produce the canonical 17-key frontmatter dict ready to feed
    ``frontmatter.render_frontmatter``.
    """
    return {
        "title": title,
        "category": CATEGORY,
        "date": ts.date().isoformat(),
        "ts": ts.isoformat(),
        "event_id": event_id,
        "role": role,
        "kind": kind,
        "direction": direction,
        "counterpart": counterpart_id or "",
        "counterpart_role": counterpart_role or "",
        "linked_event_id": linked_event_id or "",
        "session_id": session_id,
        "content_chars": int(content_chars),
        "tags": list(tags),
        "importance": importance,
        "links_to": list(links_to),
        "linked_from": [],  # populated by the linked_from batch in PR 15
    }


def build_body(
    *,
    kind: str,
    direction: str,
    counterpart_id: Optional[str],
    counterpart_role: Optional[str],
    content: str,
    payload: Optional[Dict[str, Any]],
    linked_event_id: Optional[str],
    links_to: List[str],
) -> str:
    """Render the markdown body.

    Two shapes:

      * ``tool_run_summary`` / ``task_result`` with payload — a
        structured block (status, tools, files, duration, cost) plus
        the raw body and a JSON-fenced payload dump.
      * everything else — heading + raw content.

    A trailing ``Linked`` section gathers the wikilinks from
    ``links_to`` (and the linked_event_id pointer) so an Obsidian
    reader can navigate without opening the frontmatter Properties
    pane.
    """
    arrow = _direction_arrow(direction)
    cp_short = (counterpart_id or "")[:8] if counterpart_id else ""
    role_part = f" ({counterpart_role})" if counterpart_role else ""
    heading_target = f" {arrow} {cp_short}{role_part}" if cp_short else f"{role_part}"
    heading = f"# {kind}{heading_target}"

    parts: List[str] = [heading, ""]

    if payload and kind in (Kind.TOOL_RUN_SUMMARY.value, Kind.TASK_RESULT.value):
        parts.extend(_render_tool_block(payload))
        parts.append("## Body")
        parts.append("")
        parts.append(content.rstrip("\n"))
        parts.append("")
        parts.append("## Raw payload")
        parts.append("```json")
        parts.append(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
        parts.append("```")
    else:
        parts.append(content.rstrip("\n"))

    # Linked footer (kept short — Obsidian deep-link targets only)
    parts.append("")
    parts.append("---")
    parts.append("**Linked:**")
    if linked_event_id:
        parts.append(f"- ↓ Originating event: `{linked_event_id}`")
    for target in links_to:
        parts.append(f"- [[{target}]]")

    return "\n".join(parts).rstrip() + "\n"


def _render_tool_block(payload: Dict[str, Any]) -> List[str]:
    """One-page summary of a tool run payload — plan §1.6.3 sample."""
    status = payload.get("status", "?")
    tools_used = payload.get("tools_used") or []
    files_written = payload.get("files_written") or []
    files_read = payload.get("files_read") or []
    bash_commands = payload.get("bash_commands") or []
    web_fetches = payload.get("web_fetches") or []
    errors = payload.get("errors") or []
    duration_ms = payload.get("duration_ms")
    cost_usd = payload.get("cost_usd")
    total_calls = payload.get("total_calls")
    ok_calls = payload.get("ok_calls")
    failed_calls = payload.get("failed_calls")

    out: List[str] = []
    out.append(f"**Status:** {status}")
    if tools_used:
        tool_summary = ", ".join(sorted(set(tools_used)))
        if total_calls is not None and ok_calls is not None and failed_calls is not None:
            out.append(
                f"**Tools:** {tool_summary} "
                f"({total_calls} call{'s' if total_calls != 1 else ''} · "
                f"{ok_calls} ok / {failed_calls} failed)"
            )
        else:
            out.append(f"**Tools:** {tool_summary}")
    if files_written:
        out.append("**Files written:**")
        for f in files_written:
            out.append(f"- `{f}`")
    if files_read:
        out.append("**Files read:**")
        for f in files_read:
            out.append(f"- `{f}`")
    if bash_commands:
        out.append(f"**Bash commands:** {len(bash_commands)}")
    if web_fetches:
        out.append(f"**Web fetches:** {len(web_fetches)}")
    if errors:
        out.append(f"**Errors:** {len(errors)}")
        for e in errors[:3]:
            out.append(f"- `{e}`")
    if duration_ms is not None:
        out.append(f"**Duration:** {int(duration_ms) / 1000:.1f}s")
    if cost_usd is not None:
        out.append(f"**Cost:** ${float(cost_usd):.4f}")
    out.append("")
    return out


# ─────────────────────────────────────────────────────────────────
# The archiver
# ─────────────────────────────────────────────────────────────────


class ConversationArchiver:
    """Writer for ``memory/conversations/<date>/<id>.md`` notes.

    Construct one per session::

        archiver = ConversationArchiver(memory_dir, session_id="...")
        result = archiver.archive(role, content, metadata)

    PR 1 scope only provides the writer; PR 2 hooks it into
    ``SessionMemoryManager.record_message`` so every recorded turn
    automatically lands a conversation note.
    """

    CATEGORY = CATEGORY  # re-exposed for callers

    def __init__(
        self,
        memory_dir: str,
        *,
        session_id: str = "",
        tz: Optional[tzinfo] = None,
        index_manager: Optional[Any] = None,
    ) -> None:
        self._memory_dir = Path(memory_dir)
        self._session_id = session_id
        self._tz = tz or _get_tz()
        # PR 3 — concurrency lock guarding the
        # collision-detect-then-write critical section in
        # ``_write_to_disk``. Without it two threads creating events
        # in the same second can both observe ``not target.exists()``
        # for the same widened name and one of them silently loses
        # its body to the other. RLock matches the ShortTermMemory
        # pattern so re-entrant test fakes don't deadlock.
        import threading  # local — keeps the module's eager import set lean
        self._lock = threading.RLock()
        # PR 9 follow-up — propagate writes into the MemoryIndexManager
        # so each conversation note appears in ``_index.json`` and the
        # vault_map cache is regenerated on the same trip. Optional —
        # legacy callers without an index keep working (no surface).
        self._index_manager = index_manager

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    @property
    def conversations_dir(self) -> Path:
        return self._memory_dir / CATEGORY

    def archive(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]],
    ) -> Optional[ArchivedConversation]:
        """Write one conversation note. Returns ``None`` for legacy
        metadata or invalid inputs (caller should treat that as
        "skip — let the legacy STM line stand alone").
        """
        view = parse_event_metadata(metadata)
        if view is None:
            return None
        return self._archive_view(role, content, view)

    # ── internal ─────────────────────────────────────────────────

    def _archive_view(
        self,
        role: str,
        content: str,
        view: InteractionEventView,
    ) -> Optional[ArchivedConversation]:
        ts = self._resolve_ts(view.metadata)
        content = content if isinstance(content, str) else ""
        content_chars = len(content)
        payload = view.payload or None

        importance = compute_importance(
            kind=view.kind, content_chars=content_chars, payload=payload,
        )
        title = build_title(
            kind=view.kind, direction=view.direction,
            counterpart_id=view.counterpart_id, content=content,
        )
        date_subdir, _ = filename_for(
            ts=ts, role=role, event_id=view.event_id,
        )
        links_to = build_links_to(
            kind=view.kind, counterpart_id=view.counterpart_id,
            date=date_subdir,
        )
        tags = build_tags(kind=view.kind, counterpart_role=view.counterpart_role)

        frontmatter_dict = build_frontmatter(
            title=title,
            ts=ts,
            event_id=view.event_id,
            role=role,
            kind=view.kind,
            direction=view.direction,
            counterpart_id=view.counterpart_id,
            counterpart_role=view.counterpart_role,
            linked_event_id=view.linked_event_id,
            session_id=self._session_id,
            content_chars=content_chars,
            importance=importance,
            tags=tags,
            links_to=links_to,
        )
        body = build_body(
            kind=view.kind, direction=view.direction,
            counterpart_id=view.counterpart_id,
            counterpart_role=view.counterpart_role,
            content=content, payload=payload,
            linked_event_id=view.linked_event_id, links_to=links_to,
        )

        full = render_frontmatter(frontmatter_dict, body)
        rel_path = self._write_to_disk(date_subdir, role, view.event_id, full)
        if rel_path is None:
            return None
        return ArchivedConversation(
            relative_path=rel_path,
            absolute_path=str(self._memory_dir / rel_path),
            importance=importance,
            event_id=view.event_id,
        )

    def _resolve_ts(self, metadata: Dict[str, Any]) -> datetime:
        """Pick a timestamp for the note.

        Prefers ``metadata.ts`` (the InteractionEvent producer's
        clock — keeps consistency with STM jsonl). Falls back to
        provider-now when metadata didn't carry one.
        """
        raw = metadata.get("ts")
        if isinstance(raw, str) and raw:
            try:
                parsed = datetime.fromisoformat(raw)
                return parsed.astimezone(self._tz) if parsed.tzinfo else parsed.replace(tzinfo=self._tz)
            except ValueError:
                pass
        return datetime.now(self._tz)

    def _write_to_disk(
        self,
        date_subdir: str,
        role: str,
        event_id: str,
        full_text: str,
    ) -> Optional[str]:
        """Materialise the file under ``conversations/<date>/<name>.md``,
        widening the eid prefix on collision.
        """
        date_dir = self.conversations_dir / date_subdir
        try:
            date_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning("conversation_archiver: mkdir failed for %s: %s", date_dir, exc)
            return None

        ts_part = full_text  # keep reference; renamed for read-time symmetry
        # Use the real ts encoded in the filename — re-derive from
        # the file_for helper so collision widening reuses the same
        # base. We need ts again here; we already used it above to
        # build date_subdir. Pull it out of the frontmatter.
        # (Keeping things robust: re-parse from the rendered text.)
        ts_match = re.search(r"^ts:\s*(\S+)\s*$", full_text, re.MULTILINE)
        if not ts_match:
            logger.warning("conversation_archiver: rendered note lacked ts frontmatter")
            return None
        try:
            ts = datetime.fromisoformat(ts_match.group(1).strip().strip('"'))
        except ValueError:
            return None

        # Lock the whole exists()-then-write critical section so a
        # concurrent writer can't see the same "absent" filename and
        # both proceed to clobber each other (one loses its body
        # silently). PR 3.
        with self._lock:
            for width in range(EID_WIDTH_DEFAULT, EID_WIDTH_MAX + 1, 4):
                _, name = filename_for(
                    ts=ts, role=role, event_id=event_id, eid_width=width,
                )
                target = date_dir / name
                if not target.exists():
                    try:
                        target.write_text(ts_part, encoding="utf-8")
                    except OSError as exc:
                        logger.warning(
                            "conversation_archiver: write failed for %s: %s",
                            target, exc,
                        )
                        return None
                    rel = target.relative_to(self._memory_dir)
                    rel_str = rel.as_posix()
                    # Notify the index manager (best-effort) so the
                    # _index.json + _vault_map.json refresh on each
                    # turn rather than waiting for a manual rebuild.
                    if self._index_manager is not None:
                        try:
                            self._index_manager.update_file(rel_str)
                        except Exception:
                            logger.debug(
                                "conversation_archiver: index update failed",
                                exc_info=True,
                            )
                    return rel_str
                # Collision: a file with the same time / role / eid prefix
                # already exists. Try a wider eid prefix.
            logger.warning(
                "conversation_archiver: could not allocate a unique filename "
                "for event_id=%s after widening to %d chars", event_id, EID_WIDTH_MAX,
            )
            return None


__all__ = [
    "CATEGORY",
    "EID_WIDTH_DEFAULT",
    "EID_WIDTH_MAX",
    "LONG_BODY_THRESHOLD",
    "SHORT_BODY_THRESHOLD",
    "TITLE_PREFIX_CHARS",
    "ArchivedConversation",
    "ConversationArchiver",
    "build_body",
    "build_frontmatter",
    "build_links_to",
    "build_tags",
    "build_title",
    "compute_importance",
    "filename_for",
    "sanitize_counterpart",
    "short_event_id",
]
