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


# Module-level export consumed by ToolLoader (Stage D wires this up).
TOOLS = [
    MemoryStatusTool(),
    MemoryWithTool(),
]
