"""Conversation archiver — Memory v2 session-rollup writer.

Memory v2 PR 13 (cycle 20260503_2). The archiver used to materialise
**one file per turn** under
``conversations/<YYYY-MM-DD>/<HH-MM-SS>__<role>__<eid8>.md``. That
gave audit-grade granularity at the cost of file explosion (a single
session quickly produced dozens of files; 100s of sessions blew past
1k files in ``conversations/`` alone) and a noisy Obsidian sidebar
that buried the actually-useful files (curated topics, pinned
critical facts).

This rewrite ships **session rollup**: each session gets exactly one
file under

    memory/conversations/<session_id_slug>__<title_slug>.md

and every recorded turn becomes an H2 anchor inside that file::

    ---
    title: ...
    category: conversations
    session_id: <id>
    date_first: 2026-05-03
    date_last: 2026-05-03
    turn_count: 7
    event_ids: [eid8, eid8, ...]
    kinds: [user_chat, assistant_chat, reflection]
    counterparts: [owner:gkfua00]
    importance_max: high
    tags: [conversation, user_chat, assistant_chat, ...]
    links_to: [2026-05-03, dms/owner_gkfua00/2026-05-03]
    linked_from: []
    ---

    # <title>

    ## turn-0e1c4dff

    <!--meta
    event_id: 0e1c4dff-...
    ts: 2026-05-03T08:48:49+09:00
    kind: user_chat
    direction: in
    counterpart: owner:gkfua00
    counterpart_role: user
    role: user_chat
    importance: medium
    content_chars: 12
    linked_event_id:
    -->

    [body verbatim — same render as the legacy per-turn file]

    ---

    ## turn-a8d9d03e
    ...

The wikilink target consumers (``dm_archiver`` /
``daily_journal_writer``) keep working unchanged: their ``.md``-strip
is now a no-op because :attr:`ArchivedConversation.relative_path`
already returns the wikilink-friendly form
``conversations/<sid>__<title>#turn-<eid8>`` (no extension, anchor
included). Operators clicking the link in Obsidian/Opsidian land
exactly on the per-turn heading.

Concrete invariants the rest of Memory v2 depends on:

  1. **One session = one file.** Subsequent turns *append* an H2
     anchor; the file's frontmatter is updated atomically (read →
     mutate → write-tempfile-then-rename) so concurrent writers in
     the same session can't interleave half-written blocks.
  2. **Filename is fixed at first archive.** The ``title_slug`` is
     derived from the first user-side body (or falls back to the
     session-id prefix) and never changes after — keeps the
     wikilink target stable across the session lifetime.
  3. **Body never truncates.** The whole content survives as-is in
     the per-turn block; the STM jsonl mirror still applies its
     own cap independently.
  4. **Importance is computed, not asked** (unchanged from the
     per-turn era — see :func:`compute_importance`).
  5. **Frontmatter is roll-up.** The session-level keys aggregate
     across turns: ``importance_max`` is the max across all turns,
     ``kinds``/``counterparts``/``tags``/``event_ids`` are deduped
     unions, ``date_last`` is the latest turn ts, ``turn_count``
     is the running count.

The legacy per-turn helpers (``filename_for``, ``build_title``,
``build_frontmatter``, ``build_body``) are kept as **module-level
exports for the migration script and tests** — their logic feeds
the per-turn block renderer. Direct callers that want the legacy
layout should pin geny / scripts to before this change.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, tzinfo
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from service.memory.frontmatter import parse_frontmatter, render_frontmatter
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

#: Default short-event-id width for anchor ids. 8 hex chars give
#: ~4 billion combinations per session — collisions are theoretically
#: possible but in practice never materialise within one session.
EID_WIDTH_DEFAULT = 8
EID_WIDTH_MAX = 32  # full uuid hex

#: Counterpart ids that don't represent an external party — wikilinks
#: to ``dms/<x>`` are not generated for these.
_SELF_LIKE_COUNTERPARTS = frozenset({"self", "system", "", "unknown"})

#: Kinds that warrant a ``dms/<cp>/<date>`` wikilink in
#: ``links_to``. Mirrors the kind set the dm_archiver uses for
#: per-counterpart-per-day index bundling.
_DM_KINDS = frozenset({
    Kind.DM.value,
    Kind.TASK_REQUEST.value,
    Kind.TASK_RESULT.value,
    Kind.TOOL_RUN_SUMMARY.value,
})

#: Sanitiser for path / filename components.
_PATH_SAFE_RE = re.compile(r"[^A-Za-z0-9_\-]")

#: Heuristic thresholds for :func:`compute_importance`.
LONG_BODY_THRESHOLD = 5_000
SHORT_BODY_THRESHOLD = 50

#: Title prefix length for non-payload kinds. Body's first non-empty
#: line is summarised down to this many chars in the per-turn meta
#: block.
TITLE_PREFIX_CHARS = 80

#: Maximum number of characters the *session title* slug consumes.
#: Tight enough that the on-disk filename remains comfortably under
#: 255 bytes after combining with the session-id slug.
SESSION_TITLE_SLUG_MAX = 60

#: Maximum number of characters the *session id slug* consumes.
SESSION_ID_SLUG_MAX = 24

#: Importance ladder for ``importance_max`` aggregation. Higher
#: index = more critical.
_IMPORTANCE_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_IMPORTANCE_NAME = {v: k for k, v in _IMPORTANCE_RANK.items()}

#: Per-turn meta block delimiters. HTML comments so Obsidian /
#: vault rendering ignores them while machine consumers (the
#: migration helper, future inspection tools) can still parse.
_TURN_META_OPEN = "<!--meta"
_TURN_META_CLOSE = "-->"

#: Regex used by the migration script (and tests) to enumerate
#: turn blocks inside a rollup file.
_TURN_BLOCK_RE = re.compile(
    r"^## turn-(?P<eid>[0-9a-f]+)\s*$",
    re.MULTILINE | re.IGNORECASE,
)


# ─────────────────────────────────────────────────────────────────
# Public dataclass
# ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ArchivedConversation:
    """Result of a successful :meth:`ConversationArchiver.archive` call.

    Returned to callers (``record_message``) so they can stamp
    ``payload.conversation_ref`` on the STM jsonl line — this is
    the pointer the Stream tab follows when an operator clicks an
    event row.

    With session rollup, ``relative_path`` carries the **wikilink
    target** form (no ``.md`` suffix, anchor included), e.g.
    ``conversations/sid_xxx__title#turn-0e1c4dff``. The
    ``absolute_path`` is the on-disk markdown file (with ``.md``).
    """

    relative_path: str   # e.g. "conversations/sid_xxx__title#turn-0e1c4dff"
    absolute_path: str   # e.g. "/.../memory/conversations/sid_xxx__title.md"
    importance: str
    event_id: str


# ─────────────────────────────────────────────────────────────────
# Importance heuristic
# ─────────────────────────────────────────────────────────────────


def compute_importance(
    *,
    kind: str,
    content_chars: int,
    payload: Optional[Dict[str, Any]],
) -> str:
    """Map a turn to ``low | medium | high | critical``.

    Same rules as the per-turn era so importance values round-trip
    across the migration:

      * ``critical`` — ``kind == system_note`` AND payload reports
        at least one error.
      * ``high``     — ``kind == task_result`` AND files_written≥1,
                      OR content_chars > 5000,
                      OR payload reports errors.
      * ``low``      — ``kind ∈ {reflection, internal_trigger}`` or
                      content_chars < 50.
      * ``medium``   — anything else.
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
# Slug / filename helpers
# ─────────────────────────────────────────────────────────────────


def sanitize_counterpart(counterpart_id: str) -> str:
    """Strip a counterpart id to a path-safe slug.

    Owner ids like ``owner:gkfua00`` collapse to ``owner_gkfua00``;
    UUIDs stay intact.
    """
    cleaned = _PATH_SAFE_RE.sub("_", counterpart_id or "unknown")
    return cleaned[:80] or "unknown"


def short_event_id(event_id: str, *, width: int = EID_WIDTH_DEFAULT) -> str:
    """Truncate a uuid hex to ``width`` chars. ``width`` is clamped
    to ``[1, EID_WIDTH_MAX]``.
    """
    eid = (event_id or "").strip()
    if not eid:
        eid = "00000000"
    return eid[: max(1, min(EID_WIDTH_MAX, width))]


def _slug_for_session_id(session_id: str) -> str:
    """Compress a session id into a filename component.

    Session ids in Geny look like UUIDs; the leading 24 hex chars
    are uniqueness-sufficient and keep the filename short. Empty
    input degrades to ``unknown`` so the writer never produces an
    empty slug.
    """
    cleaned = _PATH_SAFE_RE.sub("_", session_id or "unknown")
    cleaned = cleaned[:SESSION_ID_SLUG_MAX] or "unknown"
    return cleaned


def _slug_for_title(title: str) -> str:
    """Convert a free-form title into a filename component.

    Lowercases Latin scripts, keeps Hangul + digits + ``-_``, collapses
    runs of whitespace/underscore to ``-``, caps at
    ``SESSION_TITLE_SLUG_MAX``.
    """
    if not title:
        return ""
    raw = title.lower().strip()
    raw = re.sub(r"[^a-z0-9가-힣\s_-]", "", raw)
    raw = re.sub(r"[\s_]+", "-", raw)
    raw = raw.strip("-")
    return raw[:SESSION_TITLE_SLUG_MAX]


def session_filename_for(*, session_id: str, title_slug: str) -> str:
    """Return the relative path for a session rollup file.

    Shape: ``conversations/<sid_slug>__<title_slug>.md`` with the
    ``__<title_slug>`` part dropped when there's no usable title.
    """
    sid = _slug_for_session_id(session_id)
    if title_slug:
        return f"{CATEGORY}/{sid}__{title_slug}.md"
    return f"{CATEGORY}/{sid}.md"


# ── Legacy per-turn helpers (kept for migration + tests) ──────────


def filename_for(
    *,
    ts: datetime,
    role: str,
    event_id: str,
    eid_width: int = EID_WIDTH_DEFAULT,
) -> Tuple[str, str]:
    """Legacy per-turn filename layout.

    .. deprecated:: PR 13 — session rollup is now the default. This
        helper survives so the migration script can recompute
        legacy paths when walking old vaults; new writes do not
        call it.
    """
    safe_role = _PATH_SAFE_RE.sub("_", role or "unknown") or "unknown"
    date = ts.date().isoformat()
    name = (
        f"{ts.strftime('%H-%M-%S')}__{safe_role}__"
        f"{short_event_id(event_id, width=eid_width)}.md"
    )
    return date, name


# ─────────────────────────────────────────────────────────────────
# Body / heading builders
# ─────────────────────────────────────────────────────────────────


def build_title(
    *,
    kind: str,
    direction: str,
    counterpart_id: Optional[str],
    content: str,
) -> str:
    """Compose a one-line title for the per-turn meta block.

    Same shape as the legacy per-turn frontmatter title — keeps the
    StreamTab event row excerpt and the migration round-trip
    bit-for-bit identical.
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

    Identical to the per-turn era — the daily journal target plus
    (for DM-class kinds) the per-counterpart bundle. The links live
    on the *session-level* frontmatter now (deduped union across
    all turns).
    """
    out: List[str] = [date]
    cp_id = (counterpart_id or "").strip()
    if cp_id and cp_id not in _SELF_LIKE_COUNTERPARTS:
        cp_safe = sanitize_counterpart(cp_id)
        if kind in _DM_KINDS:
            out.append(f"dms/{cp_safe}/{date}")
    return out


def build_tags(*, kind: str, counterpart_role: Optional[str]) -> List[str]:
    """Standard tag set: ``conversation`` always, then kind, then
    counterpart_role (if any).
    """
    tags = ["conversation", kind]
    if counterpart_role:
        tags.append(counterpart_role)
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
    """Produce the legacy 17-key per-turn frontmatter dict.

    .. deprecated:: PR 13 — session rollup uses
        :func:`build_session_frontmatter` and per-turn HTML comment
        meta blocks. This helper survives for migration tests that
        re-read legacy per-turn files.
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
        "linked_from": [],
    }


def build_session_frontmatter(
    *,
    session_id: str,
    title: str,
    date_first: str,
    date_last: str,
    turn_count: int,
    event_ids: Iterable[str],
    kinds: Iterable[str],
    counterparts: Iterable[str],
    importance_max: str,
    tags: Iterable[str],
    links_to: Iterable[str],
) -> Dict[str, Any]:
    """Produce the session-level frontmatter dict used by the
    rollup file. Stable across a session's lifetime — the title is
    set on first archive and never changes; the rest is recomputed
    every append from the union of turn blocks.
    """
    return {
        "title": title,
        "category": CATEGORY,
        "session_id": session_id,
        "date_first": date_first,
        "date_last": date_last,
        "turn_count": int(turn_count),
        "event_ids": list(event_ids),
        "kinds": list(kinds),
        "counterparts": list(counterparts),
        "importance_max": importance_max,
        "tags": list(tags),
        "links_to": list(links_to),
        "linked_from": [],
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
    """Render the per-turn body — shape is unchanged from the legacy
    per-turn era so users reading either form see the same prose.

    Two shapes:

      * ``tool_run_summary`` / ``task_result`` with payload — a
        structured block (status, tools, files, duration, cost) plus
        the raw body and a JSON-fenced payload dump.
      * everything else — heading + raw content.
    """
    arrow = _direction_arrow(direction)
    cp_short = (counterpart_id or "")[:8] if counterpart_id else ""
    role_part = f" ({counterpart_role})" if counterpart_role else ""
    heading_target = f" {arrow} {cp_short}{role_part}" if cp_short else f"{role_part}"
    heading = f"### {kind}{heading_target}"

    parts: List[str] = [heading, ""]

    if payload and kind in (Kind.TOOL_RUN_SUMMARY.value, Kind.TASK_RESULT.value):
        parts.extend(_render_tool_block(payload))
        parts.append("#### Body")
        parts.append("")
        parts.append(content.rstrip("\n"))
        parts.append("")
        parts.append("#### Raw payload")
        parts.append("```json")
        parts.append(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
        parts.append("```")
    else:
        parts.append(content.rstrip("\n"))

    if linked_event_id:
        parts.append("")
        parts.append(f"_↳ Linked event: `{linked_event_id}`_")

    return "\n".join(parts).rstrip() + "\n"


def _render_tool_block(payload: Dict[str, Any]) -> List[str]:
    """One-page summary of a tool run payload."""
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
# Per-turn anchor rendering
# ─────────────────────────────────────────────────────────────────


def _render_meta_block(
    *,
    event_id: str,
    ts: datetime,
    role: str,
    kind: str,
    direction: str,
    counterpart_id: Optional[str],
    counterpart_role: Optional[str],
    importance: str,
    content_chars: int,
    linked_event_id: Optional[str],
) -> str:
    """Render the per-turn ``<!--meta ... -->`` block.

    The block carries the same dimensions the legacy per-turn
    frontmatter exposed; downstream tools (Stream tab inspector,
    memory_event lookup) can parse it line-by-line. Hidden from
    Obsidian preview because HTML comments don't render.
    """
    lines = [
        _TURN_META_OPEN,
        f"event_id: {event_id}",
        f"ts: {ts.isoformat()}",
        f"kind: {kind}",
        f"direction: {direction}",
        f"counterpart: {counterpart_id or ''}",
        f"counterpart_role: {counterpart_role or ''}",
        f"role: {role}",
        f"importance: {importance}",
        f"content_chars: {int(content_chars)}",
        f"linked_event_id: {linked_event_id or ''}",
        _TURN_META_CLOSE,
    ]
    return "\n".join(lines)


def render_turn_block(
    *,
    eid8: str,
    event_id: str,
    ts: datetime,
    role: str,
    kind: str,
    direction: str,
    counterpart_id: Optional[str],
    counterpart_role: Optional[str],
    importance: str,
    content_chars: int,
    linked_event_id: Optional[str],
    body: str,
) -> str:
    """Compose one anchored block: ``## turn-<eid8>`` + meta + body.

    Always trailing-separator-friendly so ``"\\n\\n".join(blocks)``
    produces a valid roll-up document.
    """
    parts = [
        f"## turn-{eid8}",
        "",
        _render_meta_block(
            event_id=event_id,
            ts=ts,
            role=role,
            kind=kind,
            direction=direction,
            counterpart_id=counterpart_id,
            counterpart_role=counterpart_role,
            importance=importance,
            content_chars=content_chars,
            linked_event_id=linked_event_id,
        ),
        "",
        body.rstrip(),
    ]
    return "\n".join(parts).rstrip() + "\n"


# ─────────────────────────────────────────────────────────────────
# Title resolution (chosen on first archive, then frozen)
# ─────────────────────────────────────────────────────────────────


_MD_HEADING_RE = re.compile(r"^#+\s")


def _first_meaningful_line(content: str) -> str:
    """Return the first non-empty, non-markdown-heading line of
    ``content`` capped at the session-title length. Used to seed
    the session title from a turn body.
    """
    for raw in (content or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if _MD_HEADING_RE.match(line):
            # Body's structural heading — not the session intent.
            continue
        return line[:SESSION_TITLE_SLUG_MAX].rstrip()
    return ""


def derive_session_title(
    *,
    kind: str,
    direction: str,
    content: str,
) -> str:
    """Pick the human-readable session title from the *first* turn
    that lands.

    Reflections and system notes don't seed a title — the writer
    falls back to the session id slug for those sessions. For
    everything else, the first non-empty, non-heading line of the
    body wins (so a markdown body that starts with ``# header``
    still picks the prose underneath).
    """
    if kind in (Kind.REFLECTION.value, "internal_trigger", Kind.SYSTEM_NOTE.value):
        return ""
    return _first_meaningful_line(content)


# ─────────────────────────────────────────────────────────────────
# The archiver
# ─────────────────────────────────────────────────────────────────


class ConversationArchiver:
    """Session-rollup writer for ``memory/conversations/<sid>__<title>.md``.

    Construct one per session::

        archiver = ConversationArchiver(memory_dir, session_id="...")
        result = archiver.archive(role, content, metadata)

    The first ``archive`` call materialises the file with a
    session-level frontmatter and one anchored block. Subsequent
    calls append a new block and update the frontmatter aggregates.
    All disk mutations go through a per-session :class:`threading.RLock`
    so concurrent archive calls never interleave each other's
    payloads.
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
        # Lock guards the read-mutate-write critical section so two
        # concurrent ``archive`` calls in the same session can't
        # produce torn files.
        import threading  # local import — keeps the eager import set lean
        self._lock = threading.RLock()
        self._index_manager = index_manager
        # Cached relative path once the file exists. Populated on
        # first archive so subsequent appends skip the title
        # derivation step (the title is fixed for the session).
        self._cached_rel: Optional[str] = None

    @property
    def memory_dir(self) -> Path:
        return self._memory_dir

    @property
    def conversations_dir(self) -> Path:
        return self._memory_dir / CATEGORY

    # ── public API ───────────────────────────────────────────────

    def archive(
        self,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]],
    ) -> Optional[ArchivedConversation]:
        """Append one turn to the session rollup file.

        Returns ``None`` for legacy metadata (missing the canonical
        InteractionEvent keys) — caller should treat it as
        "skip; the STM jsonl line stands alone".
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
        date_iso = ts.date().isoformat()
        links_to_for_turn = build_links_to(
            kind=view.kind, counterpart_id=view.counterpart_id, date=date_iso,
        )
        tags_for_turn = build_tags(
            kind=view.kind, counterpart_role=view.counterpart_role,
        )

        body = build_body(
            kind=view.kind,
            direction=view.direction,
            counterpart_id=view.counterpart_id,
            counterpart_role=view.counterpart_role,
            content=content,
            payload=payload,
            linked_event_id=view.linked_event_id,
            links_to=links_to_for_turn,
        )

        eid8 = short_event_id(view.event_id, width=EID_WIDTH_DEFAULT)
        turn_block = render_turn_block(
            eid8=eid8,
            event_id=view.event_id,
            ts=ts,
            role=role,
            kind=view.kind,
            direction=view.direction,
            counterpart_id=view.counterpart_id,
            counterpart_role=view.counterpart_role,
            importance=importance,
            content_chars=content_chars,
            linked_event_id=view.linked_event_id,
            body=body,
        )

        # Title is derived only on the first archive call; subsequent
        # calls reuse the existing on-disk title.
        derived_title = derive_session_title(
            kind=view.kind, direction=view.direction, content=content,
        )

        rel_md = self._merge_to_disk(
            ts=ts,
            view=view,
            tags_for_turn=tags_for_turn,
            links_for_turn=links_to_for_turn,
            importance=importance,
            eid8=eid8,
            derived_title_seed=derived_title,
            turn_block=turn_block,
        )
        if rel_md is None:
            return None

        # Wikilink target carries the anchor and drops the .md ext.
        rel_no_ext = rel_md[:-3] if rel_md.endswith(".md") else rel_md
        rel_with_anchor = f"{rel_no_ext}#turn-{eid8}"
        return ArchivedConversation(
            relative_path=rel_with_anchor,
            absolute_path=str(self._memory_dir / rel_md),
            importance=importance,
            event_id=view.event_id,
        )

    def _resolve_ts(self, metadata: Dict[str, Any]) -> datetime:
        """Pick a timestamp for the turn (prefer event-supplied)."""
        raw = metadata.get("ts")
        if isinstance(raw, str) and raw:
            try:
                parsed = datetime.fromisoformat(raw)
                return parsed.astimezone(self._tz) if parsed.tzinfo else parsed.replace(tzinfo=self._tz)
            except ValueError:
                pass
        return datetime.now(self._tz)

    # ── disk merge ───────────────────────────────────────────────

    def _merge_to_disk(
        self,
        *,
        ts: datetime,
        view: InteractionEventView,
        tags_for_turn: List[str],
        links_for_turn: List[str],
        importance: str,
        eid8: str,
        derived_title_seed: str,
        turn_block: str,
    ) -> Optional[str]:
        """Read the existing rollup file (if any), append the new
        block, recompute the session-level frontmatter, and write
        atomically. Returns the relative ``.md`` path on success.
        """
        try:
            self.conversations_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning(
                "conversation_archiver: mkdir failed for %s: %s",
                self.conversations_dir, exc,
            )
            return None

        with self._lock:
            target_rel, target_abs, existing_text = self._locate_or_initialise(
                derived_title_seed=derived_title_seed,
            )
            if target_rel is None:
                return None

            existing_meta, existing_body = _split_frontmatter_body(existing_text)
            new_body = _append_turn_block(existing_body, eid8, turn_block)

            # Idempotency: if the anchor already lived inside
            # ``existing_body``, ``_append_turn_block`` is a no-op
            # and we must not bump ``turn_count`` / ``event_ids``
            # / aggregates in the frontmatter — re-archiving the
            # same event is supposed to be a literal no-op on disk
            # so a crash-restart that replays a turn doesn't
            # double-count.
            if new_body == (existing_body or ""):
                return target_rel

            new_meta = self._merge_frontmatter(
                existing_meta=existing_meta,
                derived_title_seed=derived_title_seed,
                ts=ts,
                view=view,
                tags_for_turn=tags_for_turn,
                links_for_turn=links_for_turn,
                importance=importance,
                eid8=eid8,
            )

            full = render_frontmatter(new_meta, new_body)
            if not _atomic_write(Path(target_abs), full):
                return None

            if self._index_manager is not None:
                try:
                    self._index_manager.update_file(target_rel)
                except Exception:
                    logger.debug(
                        "conversation_archiver: index update failed",
                        exc_info=True,
                    )
            return target_rel

    def _locate_or_initialise(
        self,
        *,
        derived_title_seed: str,
    ) -> Tuple[Optional[str], Optional[str], str]:
        """Resolve the on-disk rollup file for this session.

        Returns ``(relative_path, absolute_path, existing_text)``.
        ``existing_text`` is the empty string when the file is being
        created. Returns ``(None, None, "")`` only on a hard error
        (caller treats that as "skip this turn").

        Filename resolution:

          1. If we cached one earlier in the session, reuse it.
          2. Otherwise enumerate ``conversations/<sid_slug>*.md`` —
             the first matching file is the session's rollup. (This
             path triggers when a worker restarts mid-session.)
          3. Otherwise create a new file with the title slug derived
             from this turn (or the session id alone if no title can
             be derived yet).
        """
        if self._cached_rel:
            abs_path = self._memory_dir / self._cached_rel
            try:
                text = abs_path.read_text(encoding="utf-8") if abs_path.exists() else ""
            except OSError as exc:
                logger.warning(
                    "conversation_archiver: read failed for %s: %s",
                    abs_path, exc,
                )
                return None, None, ""
            return self._cached_rel, str(abs_path), text

        sid_slug = _slug_for_session_id(self._session_id)
        prefix = f"{sid_slug}__"
        for entry in sorted(self.conversations_dir.glob("*.md")):
            stem = entry.stem
            if stem == sid_slug or stem.startswith(prefix):
                rel = f"{CATEGORY}/{entry.name}"
                self._cached_rel = rel
                try:
                    text = entry.read_text(encoding="utf-8")
                except OSError as exc:
                    logger.warning(
                        "conversation_archiver: read failed for %s: %s",
                        entry, exc,
                    )
                    return None, None, ""
                return rel, str(entry), text

        title_slug = _slug_for_title(derived_title_seed)
        rel = session_filename_for(
            session_id=self._session_id, title_slug=title_slug,
        )
        self._cached_rel = rel
        return rel, str(self._memory_dir / rel), ""

    def _merge_frontmatter(
        self,
        *,
        existing_meta: Dict[str, Any],
        derived_title_seed: str,
        ts: datetime,
        view: InteractionEventView,
        tags_for_turn: List[str],
        links_for_turn: List[str],
        importance: str,
        eid8: str,
    ) -> Dict[str, Any]:
        """Combine existing session frontmatter with this turn's
        contribution.

        Title is sticky: once a non-empty title lives in the
        existing frontmatter, it survives unchanged.
        """
        date_iso = ts.date().isoformat()
        ts_iso = ts.isoformat()

        # Title — sticky once chosen.
        existing_title = ""
        if isinstance(existing_meta.get("title"), str):
            existing_title = existing_meta["title"].strip()
        if existing_title:
            title = existing_title
        elif derived_title_seed:
            title = derived_title_seed
        else:
            sid_short = _slug_for_session_id(self._session_id)
            title = f"Session {sid_short}"

        date_first = (
            existing_meta.get("date_first")
            if isinstance(existing_meta.get("date_first"), str) and existing_meta["date_first"]
            else date_iso
        )
        date_last = date_iso

        prev_event_ids = _str_list(existing_meta.get("event_ids"))
        if eid8 not in prev_event_ids:
            prev_event_ids.append(eid8)

        prev_kinds = _str_list(existing_meta.get("kinds"))
        if view.kind and view.kind not in prev_kinds:
            prev_kinds.append(view.kind)

        prev_counterparts = _str_list(existing_meta.get("counterparts"))
        cp = (view.counterpart_id or "").strip()
        if cp and cp not in _SELF_LIKE_COUNTERPARTS and cp not in prev_counterparts:
            prev_counterparts.append(cp)

        prev_tags = _str_list(existing_meta.get("tags"))
        for t in tags_for_turn:
            if t not in prev_tags:
                prev_tags.append(t)

        prev_links = _str_list(existing_meta.get("links_to"))
        for link in links_for_turn:
            if link not in prev_links:
                prev_links.append(link)

        prev_imp_max = str(
            existing_meta.get("importance_max")
            or existing_meta.get("importance")
            or "low"
        ).lower()
        if _IMPORTANCE_RANK.get(importance, 0) > _IMPORTANCE_RANK.get(prev_imp_max, 0):
            importance_max = importance
        else:
            importance_max = prev_imp_max
        if importance_max not in _IMPORTANCE_RANK:
            importance_max = "low"

        turn_count = int(existing_meta.get("turn_count") or 0) + 1

        return build_session_frontmatter(
            session_id=self._session_id,
            title=title,
            date_first=date_first,
            date_last=date_last,
            turn_count=turn_count,
            event_ids=prev_event_ids,
            kinds=prev_kinds,
            counterparts=prev_counterparts,
            importance_max=importance_max,
            tags=prev_tags,
            links_to=prev_links,
        )


# ─────────────────────────────────────────────────────────────────
# Module helpers
# ─────────────────────────────────────────────────────────────────


def _str_list(value: Any) -> List[str]:
    """Coerce a frontmatter value to a list of strings."""
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, (str, int, float)) and str(v) != ""]
    if isinstance(value, str) and value:
        return [value]
    return []


def _split_frontmatter_body(text: str) -> Tuple[Dict[str, Any], str]:
    """Parse a markdown file into ``(frontmatter_dict, body)``.

    Empty / non-existing files map to ``({}, "")`` so the caller can
    treat them as "fresh start". Malformed frontmatter is logged at
    debug and treated the same — better to start clean than refuse
    to write a turn.
    """
    if not text:
        return {}, ""
    try:
        meta, body = parse_frontmatter(text)
    except Exception:
        logger.debug(
            "conversation_archiver: malformed frontmatter; resetting",
            exc_info=True,
        )
        return {}, ""
    return (meta or {}), (body or "")


def _append_turn_block(existing_body: str, eid8: str, turn_block: str) -> str:
    """Append ``turn_block`` to ``existing_body``, skipping if the
    same anchor already exists (idempotent re-archive of the same
    event_id is a no-op on disk).

    Re-emits the ``# <title>`` H1 header on first turn so an empty
    starting body still renders a title. The H1 is sourced from
    ``# `` line if already present in ``existing_body`` to avoid
    duplication.
    """
    anchor = f"## turn-{eid8}"
    if anchor in (existing_body or ""):
        return existing_body or ""

    sep = "\n\n---\n\n" if existing_body and existing_body.strip() else ""
    base = existing_body.rstrip() if existing_body else ""
    if not base:
        # First turn: keep the body minimal — the rollup file's
        # frontmatter already carries the title; an H1 is optional
        # and risks drifting from the frontmatter title. Skip it.
        return turn_block

    return f"{base}{sep}{turn_block}"


def _atomic_write(path: Path, contents: str) -> bool:
    """Write ``contents`` to ``path`` via temp-file + rename so a
    crash mid-write never leaves a half-rewritten rollup.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            prefix=path.stem + ".",
            suffix=".md.tmp",
            dir=str(path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(contents)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as exc:
        logger.warning(
            "conversation_archiver: write failed for %s: %s", path, exc,
        )
        return False
    return True


def iter_turn_anchors(text: str) -> Iterable[Tuple[str, int]]:
    """Yield ``(eid8, char_offset)`` for each ``## turn-<eid>`` heading.

    Used by the migration script and tests to enumerate turns
    inside a rollup file.
    """
    for match in _TURN_BLOCK_RE.finditer(text or ""):
        yield match.group("eid"), match.start()


__all__ = [
    "CATEGORY",
    "EID_WIDTH_DEFAULT",
    "EID_WIDTH_MAX",
    "LONG_BODY_THRESHOLD",
    "SHORT_BODY_THRESHOLD",
    "TITLE_PREFIX_CHARS",
    "SESSION_TITLE_SLUG_MAX",
    "SESSION_ID_SLUG_MAX",
    "ArchivedConversation",
    "ConversationArchiver",
    "build_body",
    "build_frontmatter",       # legacy / migration only
    "build_session_frontmatter",
    "build_links_to",
    "build_tags",
    "build_title",
    "compute_importance",
    "derive_session_title",
    "filename_for",            # legacy / migration only
    "iter_turn_anchors",
    "render_turn_block",
    "sanitize_counterpart",
    "session_filename_for",
    "short_event_id",
]
