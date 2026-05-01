"""Cycle 20260430_2 Stage B — progressive memory inspection tools.

VTuber lives in a single InteractionEvent stream (Stage A). These
tools let the persona walk that stream by *progressive disclosure*
— the cheapest tool first (one-line snapshot), drill in only when
the user wants more. No prompt-side data injection: every byte of
information arrives as a tool call result, never as a system-prompt
block.

Layered API (all paired-only / read-only / caller's own memory):

    L0  memory_status(counterpart?)            — one-line snapshot
    L1  memory_with(counterpart, kinds?, limit, since?)
                                                — list event metas
    L2  memory_event(event_id)                  — full payload + linked
    L3  memory_artifact(event_id, path)         — file body (size cap)

Counterpart aliases are resolved per-caller (see
:func:`_resolve_counterpart_id`) — ``"paired_subworker"`` resolves
to the caller's bound Sub-Worker session id, ``"user"`` resolves
to ``owner:<owner_username>``, and so on. Callers can also pass
the canonical id directly.

This module is bound to the VTuber environment via
``service.environment.templates`` (Stage D) — caller scope is the
session that invoked the tool.
"""

from __future__ import annotations

import json
from logging import getLogger
from typing import Any, Dict, List, Optional, Tuple

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool

logger = getLogger(__name__)


# ─── Capability presets ─────────────────────────────────────────────
# All inspection tools are pure read-only memory lookups. Concurrency
# safe (no mutation), idempotent (same inputs → same outputs).
_LOOKUP = ToolCapabilities(concurrency_safe=True, read_only=True, idempotent=True)


# ─── Internal helpers ──────────────────────────────────────────────


def _get_agent_manager():
    """Lazy import — avoid module-load circular deps."""
    from service.executor import get_agent_session_manager
    return get_agent_session_manager()


def _get_caller(session_id: str):
    """Resolve the caller's AgentSession or return None."""
    manager = _get_agent_manager()
    return manager.get_agent(session_id) or manager.resolve_session(session_id)


def _resolve_counterpart_id(caller_agent, counterpart: Optional[str]) -> Optional[str]:
    """Map a caller-supplied counterpart alias / id to the canonical id.

    Aliases (case-insensitive):

      ``"paired_subworker"`` / ``"paired_sub"`` / ``"sub"``  →
        caller's ``_linked_session_id`` (when caller is VTuber-side).
      ``"paired_vtuber"`` / ``"paired"`` →
        caller's ``_linked_session_id`` (works for either side; use
        when sub-worker code calls it).
      ``"user"``                         →
        ``owner:<owner_username>`` via canonical_user_id.
      ``"self"``                         →
        the literal "self" used by reflections.

    Anything else is treated as a canonical id and returned as-is
    (after stripping). ``None`` / empty input returns ``None`` —
    caller treats that as "any counterpart".
    """
    if not counterpart:
        return None
    alias = counterpart.strip().lower()
    if alias in ("paired_subworker", "paired_sub", "sub"):
        return getattr(caller_agent, "_linked_session_id", None) or None
    if alias in ("paired_vtuber", "paired"):
        return getattr(caller_agent, "_linked_session_id", None) or None
    if alias == "user":
        from service.memory.interaction_event import canonical_user_id
        return canonical_user_id(getattr(caller_agent, "_owner_username", None))
    if alias == "self":
        return "self"
    return counterpart.strip()


def _stm_load_all(memory_manager) -> List[Any]:
    """Load the full STM for the caller. Falls back to ``[]`` on error.

    Uses ``load_all`` (DB-first) when available — memory_inspect tools
    need to address arbitrary historical events, not just the recent
    tail.
    """
    try:
        stm = getattr(memory_manager, "short_term", None)
        if stm is None:
            return []
        return list(stm.load_all() or [])
    except Exception:
        logger.debug("STM load_all failed during inspect", exc_info=True)
        return []


def _entry_meta(entry) -> Dict[str, Any]:
    """Return entry.metadata or an empty dict."""
    meta = getattr(entry, "metadata", None)
    return meta if isinstance(meta, dict) else {}


def _is_executing_session(session_id: str) -> bool:
    """Best-effort 'is this session currently running a turn?'.

    Used by ``memory_status`` to surface an in-flight indicator
    alongside the latest event. Falls back to ``False`` on any
    lookup failure.
    """
    try:
        from service.execution.agent_executor import is_executing
        return bool(is_executing(session_id))
    except Exception:
        return False


def _ts_iso(entry) -> Optional[str]:
    ts = getattr(entry, "timestamp", None)
    if ts is None:
        return None
    try:
        return ts.isoformat()
    except Exception:
        return None


def _ok(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


def _error(msg: str) -> str:
    return json.dumps({"error": msg}, ensure_ascii=False)


# ─── B1 — memory_status ──────────────────────────────────────────────


class MemoryStatusTool(BaseTool):
    """One-line snapshot of your most recent interaction with a counterpart.

    Use this as the *first* step whenever the user asks "what's
    happening with X" or "what did Y just do". Cheap; safe to call
    any time. Drill deeper with ``memory_with`` afterwards.
    """

    name = "memory_status"
    description = (
        "One-line snapshot of your most recent interaction with a "
        "counterpart. Pass counterpart='paired_subworker' for your "
        "bound Sub-Worker, 'user' for the current human user, "
        "'self' for your own reflections, or omit it to see the "
        "latest event regardless of counterpart. Returns whether "
        "that counterpart is busy right now plus a one-line "
        "summary of the most recent event (with its event_id so "
        "you can drill in via memory_with / memory_event). "
        "Use this as the FIRST step when the user asks "
        "'what is X doing' or 'what did Y just do'. Cheap; safe "
        "to call any time."
    )
    CAPABILITIES = _LOOKUP

    def __init__(self) -> None:
        super().__init__()
        self.parameters = {
            "type": "object",
            "properties": {
                "counterpart": {
                    "type": "string",
                    "description": (
                        "Counterpart id or alias. "
                        "'paired_subworker' / 'user' / 'self' / "
                        "or a canonical id. Omit for any counterpart."
                    ),
                }
            },
            "required": [],
        }

    def run(self, session_id: str, counterpart: Optional[str] = None) -> str:
        """Return the snapshot. ``session_id`` is the caller's own id —
        injected by the runtime adapter, never seen by the LLM."""
        caller = _get_caller(session_id)
        if caller is None:
            return _error(f"caller session not found: {session_id}")

        memory = getattr(caller, "_memory_manager", None)
        if memory is None:
            return _error("caller has no memory manager")

        canonical = _resolve_counterpart_id(caller, counterpart)
        # Resolution returned None for the alias means the caller has
        # no bound counterpart in that role — surface the fact rather
        # than silently treating it as "any".
        if counterpart and canonical is None:
            return _ok({
                "counterpart": counterpart,
                "counterpart_id": None,
                "paired": False,
                "is_executing": False,
                "last_event": None,
            })

        entries = _stm_load_all(memory)
        last = _find_last_event(entries, canonical)

        # ``is_executing`` only meaningful when the canonical id is a
        # real session id (paired sub-worker / peer). owner:<name> /
        # "self" never executes.
        is_exec = False
        if canonical and not canonical.startswith("owner:") and canonical != "self":
            is_exec = _is_executing_session(canonical)

        return _ok({
            "counterpart": counterpart,
            "counterpart_id": canonical,
            "paired": canonical is not None,
            "is_executing": is_exec,
            "last_event": last,
        })


def _find_last_event(
    entries: List[Any],
    counterpart_id: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Walk STM newest-first; return one summary dict for the most
    recent event whose metadata matches ``counterpart_id`` (or any
    when None)."""
    for entry in reversed(entries):
        meta = _entry_meta(entry)
        if not meta.get("event_id"):
            continue  # legacy / pre-cycle line; skip
        if counterpart_id and meta.get("counterpart_id") != counterpart_id:
            continue
        return _summarise_event(entry, meta)
    return None


def _summarise_event(entry, meta: Dict[str, Any]) -> Dict[str, Any]:
    """One-line dict describing an event. Re-used by B2 for list
    rendering — keep the schema stable."""
    content = getattr(entry, "content", "") or ""
    summary = _short_content_preview(content, meta)
    payload = meta.get("payload") or {}
    out: Dict[str, Any] = {
        "event_id": meta.get("event_id"),
        "ts": _ts_iso(entry),
        "kind": meta.get("kind"),
        "direction": meta.get("direction"),
        "counterpart_id": meta.get("counterpart_id"),
        "counterpart_role": meta.get("counterpart_role"),
        "summary": summary,
    }
    if "linked_event_id" in meta and meta["linked_event_id"]:
        out["linked_event_id"] = meta["linked_event_id"]
    # Surface a few cheap structured hints from the payload so L0 / L1
    # users can decide whether to drill further without paying for L2.
    if isinstance(payload, dict):
        if payload.get("status"):
            out["status"] = payload["status"]
        if isinstance(payload.get("files_written"), list) and payload["files_written"]:
            out["files_written_count"] = len(payload["files_written"])
        if isinstance(payload.get("tools_used"), list) and payload["tools_used"]:
            out["tools_used_count"] = len(payload["tools_used"])
    return out


def _short_content_preview(content: str, meta: Dict[str, Any]) -> str:
    """Pick a short, human-readable line for the event.

    Strategy: take the first line of ``content`` after stripping the
    legacy STM role prefix (``[role] ``). Cap at 160 chars.
    """
    if not content:
        return ""
    text = content.strip()
    # STM ``load_all`` prefixes content with "[role] "; trim it for
    # display so summaries read cleanly across kinds.
    if text.startswith("[") and "]" in text:
        close = text.find("]")
        if close > 0 and close < 30:
            text = text[close + 1:].lstrip()
    first = text.splitlines()[0] if text else ""
    return first[:160]


# ─── B2 — memory_with ──────────────────────────────────────────────


_DEFAULT_WITH_LIMIT = 5
_MAX_WITH_LIMIT = 50


class MemoryWithTool(BaseTool):
    """List recent InteractionEvents with a specific counterpart.

    Each result includes the ``event_id`` so the persona can drill
    deeper via ``memory_event`` / ``memory_artifact``. Use after
    ``memory_status`` when the user wants more than the latest one.
    """

    name = "memory_with"
    description = (
        "List recent interactions with a specific counterpart (your "
        "paired Sub-Worker, the user, etc.). Each entry includes an "
        "`event_id` you can pass to `memory_event` for full details, "
        "plus its kind/direction/summary so you can decide which "
        "one to drill into. Use this after `memory_status` when "
        "the user wants more than the latest one. Optional `kinds` "
        "narrows to specific event kinds (e.g. ['tool_run_summary', "
        "'task_result']); `since` (event_id) returns only events "
        "after a known anchor."
    )
    CAPABILITIES = _LOOKUP

    def __init__(self) -> None:
        super().__init__()
        self.parameters = {
            "type": "object",
            "properties": {
                "counterpart": {
                    "type": "string",
                    "description": (
                        "Counterpart id or alias — same as memory_status."
                    ),
                },
                "kinds": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional kind filter. Useful values: "
                        "'user_chat', 'dm', 'task_request', "
                        "'task_result', 'tool_run_summary', "
                        "'reflection'."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": _MAX_WITH_LIMIT,
                    "default": _DEFAULT_WITH_LIMIT,
                    "description": (
                        f"Max events to return (1..{_MAX_WITH_LIMIT}, "
                        f"default {_DEFAULT_WITH_LIMIT})."
                    ),
                },
                "since": {
                    "type": "string",
                    "description": (
                        "Optional anchor — pass an `event_id` from a "
                        "prior call to get only events that happened "
                        "after it."
                    ),
                },
            },
            "required": ["counterpart"],
        }

    def run(
        self,
        session_id: str,
        counterpart: str,
        kinds: Optional[List[str]] = None,
        limit: int = _DEFAULT_WITH_LIMIT,
        since: Optional[str] = None,
    ) -> str:
        caller = _get_caller(session_id)
        if caller is None:
            return _error(f"caller session not found: {session_id}")
        memory = getattr(caller, "_memory_manager", None)
        if memory is None:
            return _error("caller has no memory manager")

        canonical = _resolve_counterpart_id(caller, counterpart)
        if canonical is None:
            return _ok({
                "counterpart": counterpart,
                "counterpart_id": None,
                "events": [],
            })

        try:
            limit_clamped = max(1, min(int(limit), _MAX_WITH_LIMIT))
        except (TypeError, ValueError):
            limit_clamped = _DEFAULT_WITH_LIMIT

        kind_filter: Optional[set] = None
        if kinds:
            kind_filter = {str(k) for k in kinds if isinstance(k, str)}

        entries = _stm_load_all(memory)
        cutoff = _resolve_since_cutoff(entries, since) if since else None

        # Walk newest-first; collect up to limit_clamped matches.
        results: List[Dict[str, Any]] = []
        for entry in reversed(entries):
            meta = _entry_meta(entry)
            if not meta.get("event_id"):
                continue
            if meta.get("counterpart_id") != canonical:
                continue
            if kind_filter is not None and meta.get("kind") not in kind_filter:
                continue
            if cutoff is not None:
                ts = getattr(entry, "timestamp", None)
                if ts is None or ts <= cutoff:
                    continue
            results.append(_summarise_event(entry, meta))
            if len(results) >= limit_clamped:
                break

        return _ok({
            "counterpart": counterpart,
            "counterpart_id": canonical,
            "events": results,
        })


def _resolve_since_cutoff(entries: List[Any], since: str):
    """Translate ``since`` into a comparable timestamp.

    Strategy:
      1. If *since* matches an event_id we have on hand, use that
         event's timestamp.
      2. Otherwise try parsing it as an ISO datetime.
      3. Failing both, return ``None`` so we don't silently drop
         everything.
    """
    if not since:
        return None
    target = since.strip()
    for entry in entries:
        meta = _entry_meta(entry)
        if meta.get("event_id") == target:
            return getattr(entry, "timestamp", None)
    try:
        from datetime import datetime
        return datetime.fromisoformat(target)
    except (TypeError, ValueError):
        return None


# ─── B3 — memory_event ──────────────────────────────────────────────


class MemoryEventTool(BaseTool):
    """Full payload for one InteractionEvent.

    The L2 step of the progressive ladder — call after
    ``memory_status`` / ``memory_with`` give you an ``event_id``.
    Returns the event's structured metadata + payload + any linked
    parent (e.g. the ``task_request`` that a ``tool_run_summary``
    points back to).
    """

    name = "memory_event"
    description = (
        "Drill into a single interaction event by its event_id. "
        "Returns full metadata, structured payload (e.g. for "
        "tool_run_summary: tools_used, files_written, "
        "bash_commands, errors, duration_ms), and the linked "
        "parent event when present (e.g. the originating "
        "task_request for a tool_run_summary). Use after "
        "memory_status / memory_with when the user wants the "
        "details of a specific interaction."
    )
    CAPABILITIES = _LOOKUP

    def __init__(self) -> None:
        super().__init__()
        self.parameters = {
            "type": "object",
            "properties": {
                "event_id": {
                    "type": "string",
                    "description": (
                        "Event id from memory_status.last_event.event_id "
                        "or memory_with.events[].event_id."
                    ),
                },
            },
            "required": ["event_id"],
        }

    def run(self, session_id: str, event_id: str) -> str:
        caller = _get_caller(session_id)
        if caller is None:
            return _error(f"caller session not found: {session_id}")
        memory = getattr(caller, "_memory_manager", None)
        if memory is None:
            return _error("caller has no memory manager")
        if not event_id or not isinstance(event_id, str):
            return _error("event_id required")

        entries = _stm_load_all(memory)
        match_entry, match_meta = _find_event_by_id(entries, event_id)
        if match_entry is None:
            return _error(f"event not found: {event_id}")

        event_block = _detailed_event(match_entry, match_meta)

        linked: Dict[str, Any] = {}
        parent_id = match_meta.get("linked_event_id")
        if parent_id:
            parent_entry, parent_meta = _find_event_by_id(entries, parent_id)
            if parent_entry is not None:
                linked["parent"] = _summarise_event(parent_entry, parent_meta)
            else:
                linked["parent"] = {"event_id": parent_id, "missing": True}

        return _ok({"event": event_block, "linked": linked})


def _find_event_by_id(
    entries: List[Any], event_id: str,
) -> Tuple[Optional[Any], Dict[str, Any]]:
    """Linear scan of STM for a specific event_id. Returns
    (entry, metadata) or (None, {})."""
    for entry in entries:
        meta = _entry_meta(entry)
        if meta.get("event_id") == event_id:
            return entry, meta
    return None, {}


def _detailed_event(entry, meta: Dict[str, Any]) -> Dict[str, Any]:
    """Full-fat representation used by ``memory_event``.

    Includes everything that's safe to surface to the LLM —
    metadata + payload + content + ts. Caller is the only one
    reading its own STM, so no scrubbing is needed.
    """
    payload = meta.get("payload") if isinstance(meta.get("payload"), dict) else {}
    return {
        "event_id": meta.get("event_id"),
        "ts": _ts_iso(entry),
        "kind": meta.get("kind"),
        "direction": meta.get("direction"),
        "counterpart_id": meta.get("counterpart_id"),
        "counterpart_role": meta.get("counterpart_role"),
        "linked_event_id": meta.get("linked_event_id"),
        "content": getattr(entry, "content", "") or "",
        "payload": payload,
    }


# ─── B4 — memory_artifact ──────────────────────────────────────────


_DEFAULT_ARTIFACT_BYTES = 65_536    # 64 KB
_MAX_ARTIFACT_BYTES = 262_144       # 256 KB


class MemoryArtifactTool(BaseTool):
    """Read a file the paired Sub-Worker wrote during a remembered run.

    The L3 step of the progressive ladder. Only opens files that are
    *both* listed in the event's ``payload.files_written`` *and*
    resolve safely under the counterpart session's working directory.
    Read-only — never writes.
    """

    name = "memory_artifact"
    description = (
        "Read the actual content of a file your paired Sub-Worker "
        "wrote in a specific run, by event_id + relative path. "
        "Use after memory_event tells you what files the run "
        "produced. The path must appear in that event's "
        "payload.files_written; absolute paths and `..` are "
        "rejected. Read-only; size is capped (default 64KB, max "
        "256KB). Returns {path, size_bytes, truncated, content}."
    )
    CAPABILITIES = _LOOKUP

    def __init__(self) -> None:
        super().__init__()
        self.parameters = {
            "type": "object",
            "properties": {
                "event_id": {
                    "type": "string",
                    "description": (
                        "Event id whose payload listed the file. "
                        "Get this from memory_event / memory_with."
                    ),
                },
                "path": {
                    "type": "string",
                    "description": (
                        "Relative path from the counterpart's "
                        "working directory (must match an entry in "
                        "the event's payload.files_written)."
                    ),
                },
                "max_bytes": {
                    "type": "integer",
                    "default": _DEFAULT_ARTIFACT_BYTES,
                    "minimum": 1,
                    "maximum": _MAX_ARTIFACT_BYTES,
                    "description": (
                        f"Maximum bytes to return (default "
                        f"{_DEFAULT_ARTIFACT_BYTES}, hard cap "
                        f"{_MAX_ARTIFACT_BYTES}). Larger files "
                        f"return truncated=true."
                    ),
                },
            },
            "required": ["event_id", "path"],
        }

    def run(
        self,
        session_id: str,
        event_id: str,
        path: str,
        max_bytes: int = _DEFAULT_ARTIFACT_BYTES,
    ) -> str:
        caller = _get_caller(session_id)
        if caller is None:
            return _error(f"caller session not found: {session_id}")
        memory = getattr(caller, "_memory_manager", None)
        if memory is None:
            return _error("caller has no memory manager")
        if not event_id or not isinstance(event_id, str):
            return _error("event_id required")
        if not path or not isinstance(path, str):
            return _error("path required")

        try:
            cap = max(1, min(int(max_bytes), _MAX_ARTIFACT_BYTES))
        except (TypeError, ValueError):
            cap = _DEFAULT_ARTIFACT_BYTES

        entries = _stm_load_all(memory)
        entry, meta = _find_event_by_id(entries, event_id)
        if entry is None:
            return _error(f"event not found: {event_id}")

        payload = meta.get("payload") if isinstance(meta.get("payload"), dict) else {}
        listed = list(payload.get("files_written") or [])
        if path not in listed:
            return _error(
                "path is not declared in this event's "
                "payload.files_written"
            )

        # Path safety: relative, no traversal, no absolute paths.
        from pathlib import Path
        rel = Path(path)
        if rel.is_absolute() or any(part in ("..",) for part in rel.parts):
            return _error("path is not a safe relative path")

        # Resolve the source: the counterpart session whose run this
        # event records.
        counterpart_id = meta.get("counterpart_id")
        if not counterpart_id:
            return _error("event has no counterpart_id; cannot resolve workspace")

        manager = _get_agent_manager()
        target = (
            manager.get_agent(counterpart_id)
            or manager.resolve_session(counterpart_id)
        )
        if target is None:
            return _error(f"counterpart session not available: {counterpart_id}")

        working_dir = (
            getattr(target, "_working_dir", None)
            or getattr(target, "storage_path", None)
            or ""
        )
        if not working_dir:
            return _error("counterpart session has no working directory")

        try:
            base = Path(working_dir).resolve(strict=False)
            full = (base / rel).resolve(strict=False)
            full.relative_to(base)
        except (OSError, ValueError):
            return _error("path resolves outside the workspace")

        if not full.exists() or not full.is_file():
            return _error(f"file not found at workspace: {path}")

        try:
            size = full.stat().st_size
            with open(full, "rb") as f:
                blob = f.read(cap)
        except OSError as exc:
            return _error(f"file read failed: {exc}")

        truncated = size > cap
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            text = blob.decode("utf-8", errors="replace")

        return _ok({
            "event_id": event_id,
            "path": path,
            "size_bytes": size,
            "truncated": truncated,
            "content": text,
        })


# ─── C — memory_distill ────────────────────────────────────────────


_DEFAULT_DISTILL_EVENTS = 50
_MAX_DISTILL_EVENTS = 200
_DISTILL_NARRATIVE_MAX_CHARS = 2_000
_DISTILL_LLM_TIMEOUT_S = 60.0


def _sanitize_counterpart_for_filename(counterpart_id: str) -> str:
    """Map an arbitrary counterpart id to a safe filename stem.

    Replaces every char outside ``[A-Za-z0-9_-]`` with ``_``. Caps
    length at 80 chars so even pathologically long ids stay sane.
    """
    import re as _re
    cleaned = _re.sub(r"[^A-Za-z0-9_-]", "_", counterpart_id or "unknown")
    return cleaned[:80] or "unknown"


def _summarise_counterpart_events(
    entries: List[Any], counterpart_id: str, max_events: int,
) -> Dict[str, Any]:
    """Walk the caller's STM tail-first and pick up to *max_events*
    InteractionEvent entries with this counterpart. Returns a stats
    bundle suitable for either the tool's response or a markdown
    rendering of the same.
    """
    kept: List[Tuple[Any, Dict[str, Any]]] = []
    for entry in reversed(entries):
        meta = _entry_meta(entry)
        if not meta.get("event_id"):
            continue
        if meta.get("counterpart_id") != counterpart_id:
            continue
        kept.append((entry, meta))
        if len(kept) >= max_events:
            break

    total = len(kept)
    kind_counts: Dict[str, int] = {}
    files_written: List[str] = []
    files_seen: set = set()
    bash_total = 0
    web_total = 0
    error_total = 0
    duration_total = 0
    cost_total = 0.0
    cost_observed = False

    for _entry, meta in kept:
        kind = meta.get("kind") or "unknown"
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        payload = meta.get("payload") if isinstance(meta.get("payload"), dict) else {}
        for f in payload.get("files_written", []) or []:
            if f and f not in files_seen:
                files_seen.add(f)
                files_written.append(f)
        bash_total += len(payload.get("bash_commands") or [])
        web_total += len(payload.get("web_fetches") or [])
        error_total += len(payload.get("errors") or [])
        duration_total += int(payload.get("duration_ms") or 0)
        c = payload.get("cost_usd")
        if isinstance(c, (int, float)):
            cost_total += float(c)
            cost_observed = True

    recent = [_summarise_event(entry, meta) for entry, meta in kept[:5]]

    return {
        "counterpart_id": counterpart_id,
        "events_seen": total,
        "kind_counts": kind_counts,
        "files_written": files_written,
        "bash_commands_total": bash_total,
        "web_fetches_total": web_total,
        "errors_total": error_total,
        "duration_ms_total": duration_total,
        "cost_usd_total": cost_total if cost_observed else None,
        "recent": recent,
    }


def _render_entity_markdown(
    stats: Dict[str, Any],
    counterpart_role: Optional[str],
    *,
    narrative: Optional[str] = None,
) -> str:
    """Build a small, human-readable markdown body for the entity
    note.

    Cycle 20260430_3 F — when *narrative* is set, the LLM-summarised
    paragraph leads the body; the static stats drop below a horizontal
    rule as a verifiable evidence layer. Without *narrative*, the
    layout matches the cycle 20260430_2 stats-only baseline.
    """
    lines: List[str] = []
    lines.append(f"# Counterpart: {stats['counterpart_id']}")
    lines.append("")
    if narrative:
        lines.append(narrative.strip())
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("## Stats")
        lines.append("")
    lines.append(
        f"- Events observed: **{stats['events_seen']}**"
    )
    if counterpart_role:
        lines.append(f"- Role: `{counterpart_role}`")
    if stats["kind_counts"]:
        kc = ", ".join(
            f"{k}={v}" for k, v in sorted(stats["kind_counts"].items())
        )
        lines.append(f"- Kinds: {kc}")
    if stats["files_written"]:
        lines.append(f"- Files written: {len(stats['files_written'])}")
        for f in stats["files_written"][:10]:
            lines.append(f"    - `{f}`")
    if stats["bash_commands_total"]:
        lines.append(f"- Bash commands: {stats['bash_commands_total']}")
    if stats["web_fetches_total"]:
        lines.append(f"- Web fetches: {stats['web_fetches_total']}")
    if stats["errors_total"]:
        lines.append(f"- Errors: {stats['errors_total']}")
    if stats["duration_ms_total"]:
        lines.append(f"- Total duration: {stats['duration_ms_total']/1000:.1f}s")
    if stats["cost_usd_total"] is not None:
        lines.append(f"- Total cost: ${stats['cost_usd_total']:.4f}")

    if stats["recent"]:
        lines.append("")
        lines.append("## Recent events")
        for ev in stats["recent"]:
            ts = ev.get("ts") or ""
            kind = ev.get("kind") or "?"
            summary = ev.get("summary") or ""
            ev_id = ev.get("event_id") or ""
            lines.append(f"- `{ts}` **{kind}** — {summary} (`{ev_id}`)")

    lines.append("")
    lines.append(
        "_Auto-distilled by `memory_distill`. "
        "Re-run any time to refresh._"
    )
    return "\n".join(lines)


class MemoryDistillTool(BaseTool):
    """Summarise everything you remember about a specific counterpart.

    L4 (long-term recall) of the progressive ladder. Walks the
    caller's STM tail and produces a compact stats bundle —
    event counts by kind, files the counterpart produced, total
    bash / web / errors / duration / cost. Optionally writes the
    distilled summary as a markdown note under
    ``insights/counterpart-<sanitized>.md`` so vector / keyword
    retrieval picks it up on subsequent turns. (The legacy
    ``entities/`` location was retired in Memory v2.)
    """

    name = "memory_distill"
    description = (
        "Summarise everything you remember about a counterpart "
        "(your paired Sub-Worker, the user, etc.). Returns aggregate "
        "stats: event counts by kind, files produced, totals for "
        "bash / web / errors / duration / cost, plus the most recent "
        "5 events as a quick recap. Set `narrative=true` to ALSO "
        "run a one-shot LLM summary (uses memory_model from APIConfig); "
        "the result lands at the top of the insights note's body when "
        "`update_note=true`. Read-mostly: the note write is the only "
        "side effect, and it's gated behind `update_note`."
    )
    CAPABILITIES = ToolCapabilities(
        concurrency_safe=True, read_only=True, idempotent=True,
        max_result_chars=20_000,
    )

    def __init__(self) -> None:
        super().__init__()
        self.parameters = {
            "type": "object",
            "properties": {
                "counterpart": {
                    "type": "string",
                    "description": (
                        "Counterpart id or alias — same as memory_status."
                    ),
                },
                "max_events": {
                    "type": "integer",
                    "default": _DEFAULT_DISTILL_EVENTS,
                    "minimum": 1,
                    "maximum": _MAX_DISTILL_EVENTS,
                },
                "update_note": {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "When true, persist the distilled summary as "
                        "memory/insights/counterpart-<sanitized>.md so "
                        "it joins vector / keyword retrieval."
                    ),
                },
                "narrative": {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "When true, run a one-shot LLM summary using "
                        "memory_model. The narrative is returned in "
                        "the response and written above the stats "
                        "in the insights note (if update_note=true)."
                    ),
                },
            },
            "required": ["counterpart"],
        }

    def run(
        self,
        session_id: str,
        counterpart: str,
        max_events: int = _DEFAULT_DISTILL_EVENTS,
        update_note: bool = False,
        narrative: bool = False,
    ) -> str:
        caller = _get_caller(session_id)
        if caller is None:
            return _error(f"caller session not found: {session_id}")
        memory = getattr(caller, "_memory_manager", None)
        if memory is None:
            return _error("caller has no memory manager")

        canonical = _resolve_counterpart_id(caller, counterpart)
        if canonical is None:
            return _ok({
                "counterpart": counterpart,
                "counterpart_id": None,
                "events_seen": 0,
                "kind_counts": {},
                "recent": [],
                "note_written": None,
            })

        try:
            cap = max(1, min(int(max_events), _MAX_DISTILL_EVENTS))
        except (TypeError, ValueError):
            cap = _DEFAULT_DISTILL_EVENTS

        entries = _stm_load_all(memory)
        stats = _summarise_counterpart_events(entries, canonical, cap)

        # Try to enrich with the counterpart_role from the most recent
        # matching event so the note frontmatter / body show it.
        cp_role: Optional[str] = None
        for entry in reversed(entries):
            meta = _entry_meta(entry)
            if meta.get("counterpart_id") == canonical:
                cp_role = meta.get("counterpart_role") or None
                break

        narrative_text: Optional[str] = None
        narrative_error: Optional[str] = None
        if narrative and stats["events_seen"] > 0:
            try:
                narrative_text = _run_distill_llm(
                    caller_agent=caller,
                    counterpart_id=canonical,
                    counterpart_role=cp_role,
                    stats=stats,
                )
            except Exception as exc:
                narrative_error = str(exc)[:200]
                logger.debug(
                    "memory_distill: narrative LLM call failed", exc_info=True,
                )

        note_path: Optional[str] = None
        if update_note:
            note_path = _write_entity_note(
                memory, stats, cp_role, narrative=narrative_text,
            )

        return _ok({
            "counterpart": counterpart,
            "counterpart_id": canonical,
            "counterpart_role": cp_role,
            "events_seen": stats["events_seen"],
            "kind_counts": stats["kind_counts"],
            "files_written": stats["files_written"],
            "bash_commands_total": stats["bash_commands_total"],
            "web_fetches_total": stats["web_fetches_total"],
            "errors_total": stats["errors_total"],
            "duration_ms_total": stats["duration_ms_total"],
            "cost_usd_total": stats["cost_usd_total"],
            "recent": stats["recent"],
            "narrative": narrative_text,
            "narrative_error": narrative_error,
            "note_written": note_path,
        })


def _write_entity_note(
    memory_manager,
    stats: Dict[str, Any],
    counterpart_role: Optional[str],
    *,
    narrative: Optional[str] = None,
) -> Optional[str]:
    """Persist the distilled counterpart summary as an
    ``insights/counterpart-<sanitized>.md`` structured note.

    Memory v2 retired the ``entities/`` category — counterpart auto-
    stubs are no longer maintained because their stats duplicated
    what ``dms/<cp>/<date>.md`` and the StreamTab UI already
    surface. ``memory_distill`` is the *only* counterpart-keyed
    write that survived; its output is a curated LLM summary, so
    ``insights/`` (the Derived category in plan §1.5) is the right
    home. The filename keeps a ``counterpart-`` prefix so an agent
    grepping for a specific counterpart's distillation finds it.

    When *narrative* is provided, it is written above the stats
    block as the human-readable opener. Stats stay underneath as
    a verifiable evidence layer.
    """
    writer = getattr(memory_manager, "_structured_writer", None)
    if writer is None:
        return None
    try:
        sanitized = _sanitize_counterpart_for_filename(stats["counterpart_id"])
        rel_path = f"insights/counterpart-{sanitized}.md"
        body = _render_entity_markdown(stats, counterpart_role, narrative=narrative)
        title = f"Counterpart distillation — {stats['counterpart_id']}"
        tags = ["counterpart", "distillation"]
        if counterpart_role:
            tags.append(counterpart_role)
        if narrative:
            tags.append("narrative")
        # `filename_override` keeps repeated runs writing to the
        # same file rather than ``insights/counterpart-<x>-1.md`` etc.
        return writer.write_note(
            title=title,
            content=body,
            category="insights",
            tags=tags,
            importance="medium",
            source="distillation",
            filename_override=rel_path,
        )
    except Exception:
        logger.debug("memory_distill: write_note failed", exc_info=True)
        return None


# Cycle 20260430_3 F — LLM-driven narrative distillation
# ─────────────────────────────────────────────────────────────────


_DISTILL_SYSTEM_PROMPT = (
    "당신은 VTuber 의 long-term memory 분석 어시스턴트입니다. "
    "주어진 카운터파트와의 누적 상호작용 통계와 최근 이벤트를 보고 "
    "관계의 character 를 자연어 단락 (한국어, 2~4문장) 으로 요약합니다.\n\n"
    "규칙:\n"
    "- 협업 패턴 / 강점 / 약점 / 인상적인 순간 / 다음 단계 추천 중 "
    "데이터에 가장 잘 드러나는 것을 골라 자연스럽게 풀어쓰세요.\n"
    "- bullet 없이 평문 단락. 불필요한 도구 이름 / 절대경로 / 명령어 노출 금지.\n"
    "- 데이터에 없는 내용은 절대 추측해서 적지 말 것.\n"
    "- 사용자 / 워커 / VTuber 자신을 부르는 호칭은 자연스럽게."
)


def _run_distill_llm(
    *,
    caller_agent: Any,
    counterpart_id: str,
    counterpart_role: Optional[str],
    stats: Dict[str, Any],
) -> Optional[str]:
    """Call the configured memory_model to produce a narrative summary.

    Cycle 20260501_1 B — uses the *caller AgentSession's* shared LLM
    client and memory_model_cfg (the same handles s18's
    ReflectionResolver uses). No more private ``ClientRegistry``
    instantiation per call; no credential / base_url / provider
    drift between this tool and the in-pipeline reflection.

    Returns trimmed narrative text on success, ``None`` when the
    caller has not yet wired its client / cfg (early init, missing
    API key — same silent fallback as cycle 20260430_3 F). Raises
    on actual call failures so the caller can surface
    ``narrative_error``.
    """
    client = getattr(caller_agent, "llm_client", None)
    cfg = getattr(caller_agent, "memory_model_cfg", None)
    if client is None or cfg is None:
        return None

    # The reflection cfg is built by agent_session with max_tokens=2048
    # and temperature=0.0 for deterministic JSON. Distillation wants
    # short, slightly more flexible prose — we shadow the cfg with
    # narrative-specific knobs while keeping the *model name* identical
    # to s18 reflection.
    try:
        narrative_cfg = _shadow_cfg(cfg, max_tokens=512, temperature=0.2)
    except Exception:
        narrative_cfg = cfg

    user_prompt = _build_distill_user_prompt(
        counterpart_id=counterpart_id,
        counterpart_role=counterpart_role,
        stats=stats,
    )

    async def _call():
        return await client.create_message(
            model_config=narrative_cfg,
            messages=[{"role": "user", "content": user_prompt}],
            system=_DISTILL_SYSTEM_PROMPT,
            purpose="memory.distill_narrative",
        )

    response = _bridge_async(_call())
    text = _extract_text_from_response(response)
    if not text:
        return None
    return text.strip()[:_DISTILL_NARRATIVE_MAX_CHARS]


def _shadow_cfg(cfg: Any, *, max_tokens: int, temperature: float) -> Any:
    """Return a copy of ``cfg`` with knobs tuned for narrative output.

    Tries ``ModelConfig.replace`` (executor's preferred copy method)
    first; falls back to ``dataclasses.replace`` and finally to
    rebuilding via constructor — handles the small surface differences
    between executor versions without losing the caller's model name.
    """
    if hasattr(cfg, "replace"):
        try:
            return cfg.replace(max_tokens=max_tokens, temperature=temperature)
        except Exception:
            pass
    try:
        from dataclasses import replace as _dc_replace
        return _dc_replace(cfg, max_tokens=max_tokens, temperature=temperature)
    except Exception:
        pass
    try:
        from geny_executor.core.config import ModelConfig
        return ModelConfig(
            model=getattr(cfg, "model", ""),
            max_tokens=max_tokens,
            temperature=temperature,
            thinking_enabled=getattr(cfg, "thinking_enabled", False),
        )
    except Exception:
        return cfg


def _build_distill_user_prompt(
    *,
    counterpart_id: str,
    counterpart_role: Optional[str],
    stats: Dict[str, Any],
) -> str:
    """User-side prompt for the memory_distill narrative call."""
    lines: List[str] = []
    lines.append(f"## 카운터파트 정보")
    lines.append(f"- id: {counterpart_id}")
    if counterpart_role:
        lines.append(f"- role: {counterpart_role}")
    lines.append("")
    lines.append("## 통계")
    lines.append(f"- 누적 이벤트: {stats.get('events_seen', 0)}건")
    if stats.get("kind_counts"):
        kc = ", ".join(
            f"{k}={v}" for k, v in sorted((stats.get("kind_counts") or {}).items())
        )
        lines.append(f"- 종류 분포: {kc}")
    if stats.get("files_written"):
        lines.append(f"- 작성한 파일: {len(stats['files_written'])}개 ({', '.join(stats['files_written'][:5])}{'…' if len(stats['files_written']) > 5 else ''})")
    if stats.get("bash_commands_total"):
        lines.append(f"- bash 호출: {stats['bash_commands_total']}회")
    if stats.get("web_fetches_total"):
        lines.append(f"- web 호출: {stats['web_fetches_total']}회")
    if stats.get("errors_total"):
        lines.append(f"- 에러: {stats['errors_total']}건")
    if stats.get("duration_ms_total"):
        lines.append(f"- 누적 소요시간: {stats['duration_ms_total']/1000:.1f}s")

    recent = stats.get("recent") or []
    if recent:
        lines.append("")
        lines.append("## 최근 이벤트 (newest first)")
        for ev in recent:
            ts = ev.get("ts") or ""
            kind = ev.get("kind") or "?"
            summary = ev.get("summary") or ""
            lines.append(f"- [{ts}] {kind}: {summary}")

    lines.append("")
    lines.append("위 데이터만 사용해 2~4문장 한국어 단락으로 요약해 주세요.")
    return "\n".join(lines)


def _extract_text_from_response(response) -> str:
    """Pull text out of the executor's APIResponse without depending
    on the concrete type. Tries ``.text`` then ``.content`` / parts.
    Returns ``""`` on shape mismatches.
    """
    if response is None:
        return ""
    text = getattr(response, "text", None)
    if isinstance(text, str) and text:
        return text
    content = getattr(response, "content", None)
    if isinstance(content, list):
        out: List[str] = []
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text" and isinstance(part.get("text"), str):
                    out.append(part["text"])
            else:
                t = getattr(part, "text", None)
                if isinstance(t, str):
                    out.append(t)
        if out:
            return "\n".join(out)
    if isinstance(content, str):
        return content
    return ""


def _bridge_async(coro):
    """Cross from sync tool context into async client. Mirrors the
    pattern used by SessionCreateTool — thread-pool when an event
    loop is already running, ``asyncio.run`` otherwise.
    """
    import asyncio
    import concurrent.futures

    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None

    if loop is not None and loop.is_running():
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result(timeout=_DISTILL_LLM_TIMEOUT_S)
    return asyncio.run(coro)


# Module-level export consumed by ToolLoader (Stage D wires this up).
TOOLS = [
    MemoryStatusTool(),
    MemoryWithTool(),
    MemoryEventTool(),
    MemoryArtifactTool(),
    MemoryDistillTool(),
]
