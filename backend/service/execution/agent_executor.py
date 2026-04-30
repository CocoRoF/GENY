"""
Unified Agent Execution Service
================================

Core Philosophy:
    **All agent execution goes through this single module.**
    A chat-room broadcast is nothing more than N concurrent command
    executions.  There is ONE execution path — never two.

This module owns:
    - Active execution tracking  (_active_executions)
    - Session logging            (log_command / log_response)
    - Cost persistence           (increment_cost)
    - Auto-revival               (agent.revive)
    - Double-execution prevention
    - Timeout handling
    - Avatar state updates       (emotion extraction from output)

Both ``agent_controller`` (command tab) and ``chat_controller``
(messenger broadcast) delegate here.
"""

import asyncio
import re
import time
import uuid
from dataclasses import dataclass, asdict, field
from logging import getLogger
from typing import Any, Dict, List, Optional, Set

from service.logging.session_logger import LogLevel

logger = getLogger(__name__)


# ============================================================================
# Exceptions
# ============================================================================

class AgentNotFoundError(Exception):
    """Raised when the requested session does not exist."""


class AgentNotAliveError(Exception):
    """Raised when the session process is dead and revival failed."""


class AlreadyExecutingError(Exception):
    """Raised when a command is already running on this session."""


# ============================================================================
# Result model
# ============================================================================

@dataclass
class ExecutionResult:
    """Immutable result of a single command execution.

    ``tool_calls`` carries the per-turn tool execution log captured by
    :meth:`AgentSession._invoke_pipeline` from ``tool.call_start`` /
    ``tool.call_complete`` events. Each entry is
    ``{"name": str, "input": dict, "is_error": bool, "duration_ms": int}``.

    The list lets ``_notify_linked_vtuber`` build a meaningful
    ``[SUB_WORKER_RESULT]`` payload even when the LLM emitted no final
    text — typical for "tool-only" turns where the worker only called
    ``Write`` / ``Bash`` and skipped the chat reply. See
    ``dev_docs/20260430_1/analysis/01_subworker_dm_dual_dispatch.md``
    (R1, P0-2) for the rationale.
    """
    success: bool
    session_id: str
    output: Optional[str] = None
    error: Optional[str] = None
    duration_ms: int = 0
    cost_usd: Optional[float] = None
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ============================================================================
# App-state reference (set once during startup from main.py lifespan)
# ============================================================================

_app_state = None
"""Module-level reference to FastAPI app.state (for avatar/VTuber services)."""


def set_app_state(app_state) -> None:
    """
    Called once during startup to give the executor access to app.state.
    This avoids passing app_state through every call chain.
    """
    global _app_state
    _app_state = app_state


# ============================================================================
# Avatar state emission (called after every execution)
# ============================================================================

async def _load_mood_for_session(session_id: str):
    """Best-effort lookup of ``CreatureState.mood`` for this session.

    Returns ``None`` when:
      * the ``AgentSessionManager`` has no ``state_provider`` wired
        (classic, non-game mode),
      * the session isn't registered (background / unit-test call),
      * the agent has no ``character_id``, or
      * the provider raises for any reason.

    Never raises — the caller treats ``None`` as "no mood signal, fall
    back to text/agent_state extraction".
    """
    try:
        manager = _get_agent_manager()
        provider = getattr(manager, "state_provider", None)
        if provider is None:
            return None

        agent = manager.get_agent(session_id)
        character_id = getattr(agent, "character_id", None) if agent else None
        if not character_id:
            return None

        creature = await provider.load(character_id)
        return getattr(creature, "mood", None)
    except Exception:
        logger.debug("mood lookup failed for %s", session_id, exc_info=True)
        return None


async def _emit_avatar_state(session_id: str, result: 'ExecutionResult') -> None:
    """
    Emit avatar state update based on execution result.
    Called after _execute_core completes — ensures ALL execution paths
    (sync, async, chat broadcast) update the Live2D avatar.

    When a ``CreatureState`` is hydrated for this session, its
    ``MoodVector`` is passed into ``EmotionExtractor.resolve_emotion``
    so the facial signal reflects the accumulated mood rather than a
    keyword guess from the most recent reply (PR-X3-9).

    Best-effort: never raises.
    """
    if _app_state is None:
        return
    if not hasattr(_app_state, 'avatar_state_manager') or not hasattr(_app_state, 'live2d_model_manager'):
        return

    try:
        state_manager = _app_state.avatar_state_manager
        model_manager = _app_state.live2d_model_manager

        model = model_manager.get_agent_model(session_id)
        if not model:
            return

        from service.vtuber.emotion_extractor import EmotionExtractor
        extractor = EmotionExtractor(model.emotionMap)

        mood = await _load_mood_for_session(session_id)

        if result.success and result.output:
            # Extract emotion from agent output text
            emotion, index = extractor.resolve_emotion(
                result.output, "completed", mood=mood
            )
            await state_manager.update_state(
                session_id=session_id,
                emotion=emotion,
                expression_index=index,
                trigger="agent_output",
            )
        elif not result.success:
            # Error/timeout → set appropriate emotion
            agent_state = "timeout" if "Timeout" in (result.error or "") else "error"
            emotion, index = extractor.resolve_emotion(
                None, agent_state, mood=mood
            )
            await state_manager.update_state(
                session_id=session_id,
                emotion=emotion,
                expression_index=index,
                trigger="state_change",
            )
    except Exception:
        logger.debug("Avatar state emission failed for %s", session_id, exc_info=True)


# ============================================================================
# Sub-Worker → VTuber auto-report (called after every execution)
# ============================================================================

# Tool names whose `input` reliably carries a user-meaningful filesystem
# artifact (so we can list it under `artifacts:` in the synthesised
# `[SUB_WORKER_RESULT]` payload). Anything not in this map only
# contributes to the `Tools used: …` line.
_ARTIFACT_TOOL_KEYS: Dict[str, tuple] = {
    "Write": ("file_path", "path"),
    "Edit": ("file_path", "path"),
    "NotebookEdit": ("notebook_path", "file_path"),
    "MultiEdit": ("file_path", "path"),
}


# Cycle 20260430_1 P1-3 — pipeline-internal loop signals that are
# meaningful to the executor's stop / continue logic (see
# ``service/prompt/protocols.py``) but useless to the VTuber. A worker
# that ends a tool-only turn with nothing but `[TASK_COMPLETE]` should
# be treated as if it left no narration at all, so the synthesis path
# in ``_notify_linked_vtuber`` can do its job. The pattern is
# anchored to first/last so it only strips signals when they are the
# *only* content (we never alter intentional narration that happens
# to mention the marker word).
_LOOP_SIGNAL_PATTERN = re.compile(
    r"^\s*"
    r"(?:\[TASK_COMPLETE\]|\[BLOCKED(?::[^\]]*)?\]|\[CONTINUE(?::[^\]]*)?\])"
    r"\s*$",
)


def _strip_only_loop_signals(text: Optional[str]) -> Optional[str]:
    """Return ``text`` unchanged unless its entire content reduces to
    pipeline loop signals — in which case return ``None`` so callers
    can treat the turn as "no narration".
    """
    if not text:
        return text
    if _LOOP_SIGNAL_PATTERN.match(text.strip()):
        return None
    return text


# Cycle 20260430_2 A4 — categorisation buckets for SubWorkerRun payload.
# Same source data as the yaml-payload synthesis (P0-2), but materialised
# once into a structured dict so both the SUB_WORKER_RESULT compose path
# *and* the VTuber-side STM recorder (this PR) can read it without
# re-parsing tool_calls.

_FILES_READ_TOOLS = frozenset({"Read", "Glob", "Grep"})
_BASH_TOOLS = frozenset({"Bash"})
_WEB_TOOLS = frozenset({"WebFetch", "web_fetch", "web_search", "news_search"})
_BASH_PREVIEW_CHARS = 200
_WEB_PREVIEW_CHARS = 200
_ERROR_PREVIEW_CHARS = 200


def _categorize_tool_calls(tool_calls: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Bucket the per-turn tool log into user-meaningful categories.

    Returns a JSON-serialisable dict — the same one used as the
    ``payload`` field of the ``tool_run_summary`` InteractionEvent
    recorded on the VTuber's STM (cycle 20260430_2 A4) and as the
    structured source for ``_compose_subworker_payload_from_tools``
    (cycle 20260430_1 P0-2).

    The categorisation is intentionally narrow — only the buckets the
    VTuber persona can actually paraphrase to a non-technical user.
    Anything else lives in ``raw_tool_calls`` for debugging and
    detailed inspection.
    """
    files_written = _extract_artifacts(tool_calls)
    files_read: List[str] = []
    bash_commands: List[Dict[str, Any]] = []
    web_fetches: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    seen_files_read: set = set()

    for entry in tool_calls:
        name = entry.get("name") or "unknown"
        params = entry.get("input") or {}
        is_err = bool(entry.get("is_error"))
        duration = int(entry.get("duration_ms") or 0)

        if is_err:
            errors.append({
                "name": name,
                "duration_ms": duration,
                "input_preview": _stringify_input(params)[:_ERROR_PREVIEW_CHARS],
            })

        if name in _FILES_READ_TOOLS:
            path = (
                params.get("file_path")
                or params.get("path")
                or params.get("pattern")
                or ""
            )
            if isinstance(path, str) and path.strip():
                key = path.strip()
                if key not in seen_files_read:
                    seen_files_read.add(key)
                    files_read.append(key)
        elif name in _BASH_TOOLS:
            cmd = params.get("command", "")
            bash_commands.append({
                "command": (cmd[:_BASH_PREVIEW_CHARS] if isinstance(cmd, str) else ""),
                "ok": not is_err,
                "duration_ms": duration,
            })
        elif name in _WEB_TOOLS:
            target = (
                params.get("url")
                or params.get("query")
                or ""
            )
            web_fetches.append({
                "tool": name,
                "target": (target[:_WEB_PREVIEW_CHARS] if isinstance(target, str) else ""),
                "ok": not is_err,
                "duration_ms": duration,
            })

    total = len(tool_calls)
    n_errors = len(errors)
    if total == 0:
        status = "ok"  # vacuous; caller checks total before using
    elif n_errors == 0:
        status = "ok"
    elif n_errors == total:
        status = "failed"
    else:
        status = "partial"

    # Distinct tool names in encounter order — handy for one-line
    # summaries downstream.
    seen_names: set = set()
    tools_used: List[str] = []
    for entry in tool_calls:
        name = entry.get("name") or "unknown"
        if name in seen_names:
            continue
        seen_names.add(name)
        tools_used.append(name)

    return {
        "status": status,
        "tools_used": tools_used,
        "files_written": files_written,
        "files_read": files_read,
        "bash_commands": bash_commands,
        "web_fetches": web_fetches,
        "errors": errors,
        "total_calls": total,
        "ok_calls": total - n_errors,
        "failed_calls": n_errors,
    }


def _stringify_input(params: Dict[str, Any]) -> str:
    """Best-effort short stringification for input previews."""
    try:
        import json as _json
        return _json.dumps(params, ensure_ascii=False)[:400]
    except Exception:
        return str(params)[:400]


def _extract_artifacts(tool_calls: List[Dict[str, Any]]) -> List[str]:
    """Pull file-path artifacts out of completed tool calls.

    Only consults the whitelist in :data:`_ARTIFACT_TOOL_KEYS` —
    every other tool reports through ``Tools used:`` instead of
    inventing user-facing paths. Skips errored calls so a failed Write
    doesn't end up looking like a successful artifact.
    """
    artifacts: List[str] = []
    for entry in tool_calls:
        if entry.get("is_error"):
            continue
        keys = _ARTIFACT_TOOL_KEYS.get(entry.get("name", ""))
        if not keys:
            continue
        params = entry.get("input") or {}
        for key in keys:
            value = params.get(key)
            if isinstance(value, str) and value.strip():
                artifacts.append(value.strip())
                break
    # Deduplicate while preserving order — the worker may have edited
    # the same file twice.
    seen: set = set()
    deduped: List[str] = []
    for a in artifacts:
        if a in seen:
            continue
        seen.add(a)
        deduped.append(a)
    return deduped


def _compose_subworker_payload_from_tools(
    result: 'ExecutionResult',
) -> Optional[str]:
    """Build a worker.md-shaped ``[SUB_WORKER_RESULT]`` payload from
    :attr:`ExecutionResult.tool_calls` when the LLM left no final text.

    Returns ``None`` when there is nothing to summarise (no tool calls
    at all) — the caller should treat that as "no notification" rather
    than emitting a meaningless "Task finished with no output." line.
    See ``dev_docs/20260430_1/analysis/01_subworker_dm_dual_dispatch.md``
    (P0-2 / P0-3).
    """
    tool_calls = list(getattr(result, "tool_calls", None) or [])
    if not tool_calls:
        return None

    total = len(tool_calls)
    errors = sum(1 for t in tool_calls if t.get("is_error"))
    ok = total - errors

    if errors == 0:
        status = "ok"
    elif errors == total:
        status = "failed"
    else:
        status = "partial"

    # Distinct tool names in encounter order
    seen_names: set = set()
    name_order: List[str] = []
    for entry in tool_calls:
        name = entry.get("name") or "unknown"
        if name in seen_names:
            continue
        seen_names.add(name)
        name_order.append(name)
    tools_line = ", ".join(name_order) if name_order else "—"

    if status == "ok":
        if total == 1:
            summary = f"Completed using {tools_line} ({ok} tool call)."
        else:
            summary = f"Completed using {tools_line} ({ok} tool calls)."
    elif status == "failed":
        summary = (
            f"Could not complete the task — every tool call failed "
            f"({errors}/{total})."
        )
    else:
        summary = (
            f"Partial — {ok} tool call(s) succeeded, {errors} failed "
            f"using {tools_line}."
        )

    artifacts = _extract_artifacts(tool_calls)

    details_lines: List[str] = [
        f"Tools used: {tools_line}",
        f"Total calls: {total} ({ok} ok, {errors} failed)",
    ]

    payload_lines = [
        "[SUB_WORKER_RESULT]",
        f"status: {status}",
        f"summary: {summary}",
        "details: |",
    ]
    for line in details_lines:
        payload_lines.append(f"  {line}")
    if artifacts:
        payload_lines.append("artifacts:")
        for art in artifacts:
            payload_lines.append(f"  - {art}")
    else:
        payload_lines.append("artifacts: []")

    return "\n".join(payload_lines)


def _find_linked_task_request_event_id(
    vtuber_memory_manager,
    sub_session_id: str,
) -> Optional[str]:
    """Cycle 20260430_2 A4 — best-effort linkage from a fresh
    ``tool_run_summary`` back to its originating ``task_request`` on
    the VTuber side. Scans the VTuber's recent STM tail (last 20
    entries) for the most recent task_request whose counterpart_id
    matches the Sub-Worker's session_id.

    Returns ``None`` when no link is found — that's fine; the
    InteractionEvent without ``linked_event_id`` is still a valid
    record, just without the parent pointer.
    """
    try:
        stm = getattr(vtuber_memory_manager, "short_term", None)
        if stm is None:
            return None
        entries = stm.get_recent(20) or []
    except Exception:
        return None

    for entry in reversed(entries):
        meta = getattr(entry, "metadata", None) or {}
        if (
            meta.get("kind") == "task_request"
            and meta.get("counterpart_id") == sub_session_id
        ):
            event_id = meta.get("event_id")
            if event_id:
                return str(event_id)
    return None


def _record_subworker_run_on_vtuber(
    *,
    vtuber_agent,
    sub_session_id: str,
    result: 'ExecutionResult',
) -> None:
    """Cycle 20260430_2 A4 — record the Sub-Worker's just-completed
    turn as an InteractionEvent on the VTuber's STM, regardless of
    whether the dispatch path (P0-1 / P0-3) decides to wake the
    VTuber.

    The recording is the *environment* observation that the VTuber
    can later inspect via the progressive memory tools (B1..B5);
    it is independent of whether the VTuber is also notified to
    speak about the run.

    Genuine empty turns (no tool calls AND no meaningful output AND
    no error) are skipped — there is nothing to remember. P0-3's
    suppression policy applies here too.
    """
    try:
        memory = getattr(vtuber_agent, "_memory_manager", None)
        if memory is None:
            return

        tool_calls = list(getattr(result, "tool_calls", None) or [])
        meaningful_text = _strip_only_loop_signals(result.output) if result.success else None
        has_meaningful_text = bool(meaningful_text and meaningful_text.strip())
        has_error = bool(result.error)

        if not tool_calls and not has_meaningful_text and not has_error:
            return

        categorised = _categorize_tool_calls(tool_calls) if tool_calls else {
            "status": "failed" if has_error else ("ok" if has_meaningful_text else "ok"),
            "tools_used": [],
            "files_written": [],
            "files_read": [],
            "bash_commands": [],
            "web_fetches": [],
            "errors": [],
            "total_calls": 0,
            "ok_calls": 0,
            "failed_calls": 0,
        }
        if has_error and tool_calls:
            # error wins over per-tool status when the whole turn errored
            categorised = dict(categorised)
            categorised["status"] = "failed"

        # Short natural-language summary written into the STM `content`
        # field. The structured data lives in the metadata `payload`;
        # this string is just what shows up to the LLM via
        # recent_turns / search snippets.
        if has_meaningful_text:
            preview = meaningful_text.strip().splitlines()[0][:160] if meaningful_text else ""
            content_repr = (
                f"[Sub-Worker run] {categorised['ok_calls']}/{categorised['total_calls']} "
                f"tool calls — {preview}"
            )
        elif categorised["total_calls"] > 0:
            files = categorised["files_written"]
            file_part = (
                f", wrote {len(files)} file(s)"
                if files else ""
            )
            content_repr = (
                f"[Sub-Worker run] {categorised['ok_calls']}/"
                f"{categorised['total_calls']} tool calls"
                f"{file_part}."
            )
        else:
            content_repr = (
                f"[Sub-Worker run] failed: {(result.error or '')[:160]}"
            )

        payload = {
            **categorised,
            "duration_ms": int(result.duration_ms or 0),
            "cost_usd": result.cost_usd,
            "raw_tool_calls": tool_calls,
        }
        if has_error:
            payload["error"] = (result.error or "")[: _ERROR_PREVIEW_CHARS * 2]

        from service.memory.interaction_event import (
            CounterpartRole,
            Direction,
            Kind,
            make_event_metadata,
        )
        linked = _find_linked_task_request_event_id(memory, sub_session_id)
        meta = make_event_metadata(
            kind=Kind.TOOL_RUN_SUMMARY,
            direction=Direction.IN,
            counterpart_id=sub_session_id,
            counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            linked_event_id=linked,
            payload=payload,
        )
        # Reuse the "assistant_dm" role for the recorded line — content
        # is a short natural sentence, so retrieval / display is
        # consistent with the rest of the DM stream. The metadata.kind
        # disambiguates this from a plain DM.
        memory.record_message("assistant_dm", content_repr[:10000], metadata=meta)
    except Exception:
        logger.debug(
            "Failed to record subworker_run on VTuber STM (sub=%s)",
            sub_session_id, exc_info=True,
        )


async def _notify_linked_vtuber(session_id: str, result: 'ExecutionResult') -> None:
    """
    If this session is a Sub-Worker linked to a VTuber, fire-and-forget
    a [SUB_WORKER_RESULT] message to the VTuber so it can summarise for the user.

    Best-effort: never raises.
    """
    try:
        from service.executor import get_agent_session_manager

        manager = get_agent_session_manager()
        agent = manager.get_agent(session_id)
        if not agent:
            return

        # Only Sub-Workers with a linked VTuber should notify
        if getattr(agent, '_session_type', None) != 'sub':
            return
        linked_id = getattr(agent, 'linked_session_id', None)
        if not linked_id:
            return

        vtuber_agent = manager.get_agent(linked_id)
        if not vtuber_agent:
            return

        # Cycle 20260430_2 A4 — *always* record the run as an
        # InteractionEvent on the VTuber's STM, independent of the
        # dispatch decision below. Suppressed dispatch only means the
        # VTuber doesn't speak about the run *right now*; the
        # observation is still part of the VTuber's life history and
        # must remain inspectable via memory_with / memory_event.
        _record_subworker_run_on_vtuber(
            vtuber_agent=vtuber_agent,
            sub_session_id=session_id,
            result=result,
        )

        # Cycle 20260430_1 P0-1 — if the Sub-Worker already delivered a
        # ``[SUB_WORKER_RESULT]`` payload to the VTuber via
        # ``send_direct_message_internal`` during this turn, skip the
        # auto-fallback. Otherwise the VTuber would receive a *second*
        # notification — typically the canned "Task finished with no
        # output." line, which clobbers the structured payload it already
        # processed via Path A. See
        # ``dev_docs/20260430_1/analysis/01_subworker_dm_dual_dispatch.md``.
        if getattr(agent, "_explicit_subworker_report_sent", False):
            try:
                sender_logger = _get_session_logger(session_id, create_if_missing=False)
                if sender_logger is not None:
                    sender_logger.log(
                        level=LogLevel.INFO,
                        message="Skipping auto SUB_WORKER_RESULT — explicit payload already sent",
                        metadata={
                            "event": "delegation.suppressed_explicit_report",
                            "to_session_id": linked_id,
                        },
                    )
            except Exception:
                logger.debug(
                    "suppress-log emit failed for %s", session_id, exc_info=True,
                )
            return

        # Build a concise summary for the VTuber.
        #
        # Priority:
        #   1. The Sub-Worker's own assistant text (rare but useful when
        #      it actually narrates).
        #   2. A worker.md-shaped payload synthesised from the per-turn
        #      tool log (cycle 20260430_1 P0-2).
        #   3. A failure with a real error message.
        #   4. Genuine "nothing happened" — no text, no tools, no
        #      explicit report. Cycle 20260430_1 P0-3: skip the
        #      notification entirely instead of forwarding a
        #      meaningless "Task finished with no output." line that
        #      makes the VTuber narrate confusion to the user.
        # Cycle 20260430_1 P1-3 — pipeline loop signals (`[TASK_COMPLETE]`
        # / `[CONTINUE: …]` / `[BLOCKED: …]`) sometimes show up as the
        # entire `result.output` for tool-only turns. They're meaningful
        # to the executor's stop/continue logic but carry no
        # user-facing narration; treat them as empty so the synthesis
        # path can still kick in.
        meaningful_text = _strip_only_loop_signals(result.output)

        content: Optional[str] = None
        if result.success and meaningful_text and meaningful_text.strip():
            summary = meaningful_text[:2000]
            content = f"[SUB_WORKER_RESULT] Task completed successfully.\n\n{summary}"
        elif result.success:
            content = _compose_subworker_payload_from_tools(result)
        elif result.error:
            content = f"[SUB_WORKER_RESULT] Task failed: {result.error[:500]}"

        if content is None:
            # Nothing meaningful to forward — log the decision so the
            # timeline still shows the close-of-loop, but don't fire.
            try:
                sender_logger = _get_session_logger(session_id, create_if_missing=False)
                if sender_logger is not None:
                    sender_logger.log(
                        level=LogLevel.INFO,
                        message=(
                            "Skipping auto SUB_WORKER_RESULT — no text, no tools, "
                            "no explicit report"
                        ),
                        metadata={
                            "event": "delegation.suppressed_empty_turn",
                            "to_session_id": linked_id,
                        },
                    )
            except Exception:
                logger.debug(
                    "empty-turn suppress log emit failed for %s",
                    session_id,
                    exc_info=True,
                )
            return

        # Emit delegation.sent on the Sub-Worker's log so the flow is
        # visible from the sender side. The receiver side will emit
        # delegation.received when the VTuber's _execute_core picks up
        # the tagged prompt (via either the direct path or the inbox).
        try:
            sender_logger = _get_session_logger(session_id, create_if_missing=False)
            if sender_logger is not None:
                _sender_role = getattr(agent, "role", None)
                _target_role = getattr(vtuber_agent, "role", None)
                sender_logger.log_delegation_event(
                    "delegation.sent",
                    {
                        "tag": "[SUB_WORKER_RESULT]",
                        "from_session_id": session_id,
                        "to_session_id": linked_id,
                        "from_role": (
                            _sender_role.value if _sender_role is not None
                            and hasattr(_sender_role, "value") else _sender_role
                        ),
                        "to_role": (
                            _target_role.value if _target_role is not None
                            and hasattr(_target_role, "value") else _target_role
                        ),
                    },
                )
        except Exception:
            logger.debug("delegation.sent emit failed for %s", session_id, exc_info=True)

        # Fire-and-forget: trigger VTuber to process the result
        async def _trigger_vtuber() -> None:
            try:
                vtuber_result = await execute_command(linked_id, content)
            except AlreadyExecutingError:
                # VTuber is busy — store in inbox for later pickup
                try:
                    from service.chat.inbox import get_inbox_manager
                    inbox = get_inbox_manager()
                    inbox.deliver(
                        target_session_id=linked_id,
                        content=content,
                        sender_session_id=session_id,
                        sender_name="Sub-Worker",
                        # Cycle 20260430_1 P1-2 — tag the queued
                        # auto-notification so `_drain_inbox` can dedupe
                        # repeated SUB_WORKER_RESULT auto-fallbacks
                        # within a single drain pass.
                        metadata={
                            "tag": "[SUB_WORKER_RESULT]",
                            "source": "auto_notify_busy",
                        },
                    )
                    logger.info(
                        "VTuber %s busy — SUB_WORKER_RESULT stored in inbox", linked_id
                    )
                    sender_sl = _get_session_logger(session_id, create_if_missing=False)
                    if sender_sl is not None:
                        sender_sl.log(
                            level=LogLevel.INFO,
                            message="Recipient busy — message queued to inbox",
                            metadata={
                                "event": "inbox.delivered",
                                "to_session_id": linked_id,
                                "tag": "[SUB_WORKER_RESULT]",
                            },
                        )
                except Exception as inbox_err:
                    # Inbox also failed — store in DLQ for recovery
                    logger.warning(
                        "VTuber notification inbox fallback failed for %s: %s",
                        linked_id, inbox_err,
                    )
                    sender_sl = _get_session_logger(session_id, create_if_missing=False)
                    if sender_sl is not None:
                        sender_sl.log(
                            level=LogLevel.WARNING,
                            message=f"Inbox delivery failed — falling back to DLQ: {inbox_err}",
                            metadata={
                                "event": "inbox.fallback_dlq",
                                "to_session_id": linked_id,
                                "error": str(inbox_err),
                            },
                        )
                    try:
                        from service.chat.inbox import get_inbox_manager
                        get_inbox_manager().send_to_dlq(
                            target_session_id=linked_id,
                            content=content,
                            sender_session_id=session_id,
                            sender_name="Sub-Worker",
                            reason="vtuber_notify_inbox_failed",
                            original_error=str(inbox_err),
                        )
                    except Exception as dlq_err:
                        logger.error(
                            "VTuber notification DLQ fallback also failed for %s",
                            linked_id, exc_info=True,
                        )
                        sender_sl = _get_session_logger(session_id, create_if_missing=False)
                        if sender_sl is not None:
                            sender_sl.log(
                                level=LogLevel.ERROR,
                                message=f"DLQ fallback failed — message lost: {dlq_err}",
                                metadata={
                                    "event": "inbox.dlq_failed",
                                    "to_session_id": linked_id,
                                    "error": str(dlq_err),
                                },
                            )
            except (AgentNotFoundError, AgentNotAliveError) as exc:
                logger.debug(
                    "VTuber notification to %s skipped: %s", linked_id, exc
                )
                return

            # VTuber produced a conversational reply to the
            # [SUB_WORKER_RESULT] trigger. Without this broadcast the
            # reply is generated but never surfaces in the user's chat
            # panel — the THINKING_TRIGGER path is the only other code
            # that writes to the room, and it doesn't run here. Mirror
            # `_save_drain_to_chat_room` / `thinking_trigger.
            # _save_to_chat_room` so SSE subscribers see the response.
            _save_subworker_reply_to_chat_room(linked_id, vtuber_result)

        asyncio.create_task(_trigger_vtuber())
        logger.info(
            "Sub-Worker→VTuber auto-report queued: %s → %s", session_id, linked_id
        )

    except Exception:
        logger.debug(
            "VTuber notification failed for %s", session_id, exc_info=True
        )


async def _notify_vtuber_sub_worker_progress(session_id: str, status: str) -> None:
    """
    If this is a Sub-Worker session linked to a VTuber, update the VTuber avatar
    to show that the Sub-Worker is active (e.g., "surprise" expression).

    Best-effort: never raises.
    """
    try:
        if _app_state is None:
            return
        if not hasattr(_app_state, 'avatar_state_manager') or not hasattr(_app_state, 'live2d_model_manager'):
            return

        from service.executor import get_agent_session_manager
        manager = get_agent_session_manager()
        agent = manager.get_agent(session_id)
        if not agent:
            return
        if getattr(agent, '_session_type', None) != 'sub':
            return
        linked_id = getattr(agent, 'linked_session_id', None)
        if not linked_id:
            return

        model_manager = _app_state.live2d_model_manager
        model = model_manager.get_agent_model(linked_id)
        if not model:
            return

        state_manager = _app_state.avatar_state_manager

        if status == "executing":
            await state_manager.update_state(
                session_id=linked_id,
                emotion="surprise",
                expression_index=model.emotionMap.get("surprise", 0),
                trigger="sub_worker_progress",
            )
    except Exception:
        pass  # Best-effort


# ============================================================================
# Centralised active-execution registry
# ============================================================================

_active_executions: Dict[str, dict] = {}
"""session_id → holder dict for every in-flight execution."""

_draining_sessions: Set[str] = set()
"""Sessions currently draining their inbox (prevents infinite recursion)."""


def is_executing(session_id: str) -> bool:
    """Return True if *session_id* is currently running a command."""
    holder = _active_executions.get(session_id)
    return holder is not None and not holder.get("done", True)


def is_trigger_executing(session_id: str) -> bool:
    """Return True if *session_id* is running a trigger (preemptible)."""
    holder = _active_executions.get(session_id)
    return (
        holder is not None
        and not holder.get("done", True)
        and holder.get("is_trigger", False)
    )


def get_execution_holder(session_id: str) -> Optional[dict]:
    """Return the live holder dict, or None."""
    return _active_executions.get(session_id)


def cleanup_execution(session_id: str, exec_id: Optional[str] = None) -> None:
    """Remove the holder entry if *exec_id* matches (or is None).

    When *exec_id* is given, only remove the holder if its ``exec_id``
    matches — this prevents a finishing execution from accidentally
    removing a *newer* holder registered by a different command.
    """
    if exec_id is not None:
        holder = _active_executions.get(session_id)
        if holder and holder.get("exec_id") != exec_id:
            return  # Not our holder — leave it alone
    _active_executions.pop(session_id, None)


async def abort_trigger_execution(session_id: str) -> bool:
    """
    Cancel a running trigger execution so a higher-priority command
    (user message) can take over.

    Returns True if a trigger was successfully aborted, False otherwise.
    Only aborts executions tagged with ``is_trigger=True``.
    """
    holder = _active_executions.get(session_id)
    if not holder or holder.get("done", True):
        return False
    if not holder.get("is_trigger", False):
        return False

    abort_exec_id = holder.get("exec_id")
    task = holder.get("task")
    if not task or task.done():
        # No cancellable task — just clean up
        cleanup_execution(session_id, exec_id=abort_exec_id)
        return True

    logger.info(
        "Aborting trigger execution for %s (elapsed=%.1fs)",
        session_id,
        time.time() - holder.get("start_time", time.time()),
    )

    task.cancel()
    try:
        await task  # wait for CancelledError handling in _execute_core
    except (asyncio.CancelledError, Exception):
        pass

    # Ensure cleanup (only our holder)
    cleanup_execution(session_id, exec_id=abort_exec_id)
    return True


async def stop_execution(session_id: str) -> bool:
    """
    Cancel any running execution for a session (trigger or user-initiated).

    Returns True if an execution was stopped. Used by broadcast cancel.
    """
    holder = _active_executions.get(session_id)
    if not holder or holder.get("done", True):
        return False

    stop_exec_id = holder.get("exec_id")
    task = holder.get("task")
    if not task or task.done():
        cleanup_execution(session_id, exec_id=stop_exec_id)
        return True

    logger.info(
        "Stopping execution for %s (elapsed=%.1fs)",
        session_id,
        time.time() - holder.get("start_time", time.time()),
    )

    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass

    cleanup_execution(session_id, exec_id=stop_exec_id)
    return True


# ============================================================================
# Internal helpers (lazy imports to avoid circular deps)
# ============================================================================

def _get_agent_manager():
    from service.executor import get_agent_session_manager
    return get_agent_session_manager()


def _get_session_logger(session_id: str, *, create_if_missing: bool = True):
    from service.logging.session_logger import get_session_logger
    return get_session_logger(session_id, create_if_missing=create_if_missing)


def _get_session_store():
    from service.sessions.store import get_session_store
    return get_session_store()


# ============================================================================
# Resolve & revive agent
# ============================================================================

async def _resolve_agent(session_id: str):
    """
    Look up the agent, auto-revive if its process died.

    Returns the live AgentSession.
    Raises AgentNotFoundError / AgentNotAliveError on failure.
    """
    agent_manager = _get_agent_manager()
    agent = agent_manager.get_agent(session_id)
    if not agent:
        raise AgentNotFoundError(f"AgentSession not found: {session_id}")

    if not agent.is_alive():
        logger.info("[%s] Process not alive — attempting auto-revival", session_id)
        try:
            revived = await agent.revive()
            if revived:
                logger.info("[%s] ✅ Auto-revival successful", session_id)
                sl = _get_session_logger(session_id, create_if_missing=False)
                if sl is not None:
                    sl.log(
                        level=LogLevel.INFO,
                        message="Agent auto-revived after inactivity",
                        metadata={"event": "auto_revival", "session_id": session_id},
                    )
            else:
                raise AgentNotAliveError(
                    f"AgentSession is not running and revival failed (status: {agent.status})"
                )
        except AgentNotAliveError:
            raise
        except Exception as e:
            raise AgentNotAliveError(f"AgentSession revival error: {e}")

    return agent


# ============================================================================
# Core execution logic (shared by sync & async paths)
# ============================================================================

async def _execute_core(
    agent,
    session_id: str,
    prompt: str,
    holder: dict,
    *,
    timeout: Optional[float] = None,
    system_prompt: Optional[str] = None,
    max_turns: Optional[int] = None,
    **invoke_kwargs,
) -> ExecutionResult:
    """
    Run the full execution lifecycle once.

    1. Log command    →  session_logger.log_command
    2. Invoke agent   →  agent.invoke (with timeout)
    3. Log response   →  session_logger.log_response
    4. Persist cost   →  session_store.increment_cost

    Caller is responsible for registering/cleaning *holder* in
    ``_active_executions``.

    Extra ``invoke_kwargs`` are forwarded to ``agent.invoke()`` — e.g.
    ``is_chat_message=True`` for broadcast context.
    """
    session_logger = _get_session_logger(session_id, create_if_missing=True)
    start_time = holder["start_time"]

    # env_id / role metadata threaded into every per-turn log entry.
    # Resolved once up front so every log_command / log_response call
    # below can pass identical values, keeping the log coherent across
    # the command/response/error branches.
    log_env_id = getattr(agent, "env_id", None)
    _role = getattr(agent, "role", None)
    log_role = _role.value if _role is not None and hasattr(_role, "value") else _role

    try:
        # 1. Log command
        logger.info(
            "[Executor:%s] _execute_core: prompt=%s, timeout=%s, max_turns=%s",
            session_id[:8], prompt[:80], timeout, max_turns,
        )
        if session_logger:
            session_logger.log_command(
                prompt=prompt,
                timeout=timeout,
                system_prompt=system_prompt,
                max_turns=max_turns,
                env_id=log_env_id,
                role=log_role,
            )
            # Receiver-side delegation marker: if the incoming prompt is
            # a tagged delegation message, record a matching
            # delegation.received event so LogsTab can pair it with the
            # sender's delegation.sent entry.
            try:
                from service.vtuber.delegation import parse_delegation_headers

                headers = parse_delegation_headers(prompt)
                if headers is not None:
                    session_logger.log_delegation_event(
                        "delegation.received",
                        {
                            "tag": headers.get("tag"),
                            "from_session_id": headers.get("from_session_id"),
                            "to_session_id": session_id,
                            "task_id": headers.get("task_id"),
                            "to_role": log_role,
                        },
                    )
            except Exception:
                logger.debug(
                    "delegation.received emit failed for %s", session_id, exc_info=True,
                )

        # 2. Invoke
        effective_timeout = timeout or getattr(agent, "timeout", 21600.0)
        logger.info(
            "[Executor:%s] invoking agent (effective_timeout=%s, agent_type=%s)",
            session_id[:8], effective_timeout, type(agent).__name__,
        )
        invoke_result = await asyncio.wait_for(
            agent.invoke(input_text=prompt, **invoke_kwargs),
            timeout=effective_timeout,
        )

        result_text = (
            invoke_result.get("output", "")
            if isinstance(invoke_result, dict)
            else str(invoke_result)
        )
        result_cost = (
            invoke_result.get("total_cost", 0.0)
            if isinstance(invoke_result, dict)
            else None
        )
        # Cycle 20260430_1 P0-2 — pull the per-turn tool log out of the
        # invoke envelope so `_notify_linked_vtuber` can build a real
        # payload for tool-only turns. Older invoke paths that don't
        # include the key fall back to an empty list — same shape as
        # before.
        result_tool_calls: List[Dict[str, Any]] = []
        if isinstance(invoke_result, dict):
            raw = invoke_result.get("tool_calls") or []
            if isinstance(raw, list):
                result_tool_calls = [
                    entry for entry in raw if isinstance(entry, dict)
                ]
        duration_ms = int((time.time() - start_time) * 1000)

        logger.info(
            "[Executor:%s] invoke returned: output_len=%d, cost=%s, duration=%dms",
            session_id[:8], len(result_text), result_cost, duration_ms,
        )

        # 3. Log response
        if session_logger:
            session_logger.log_response(
                success=True,
                output=result_text,
                duration_ms=duration_ms,
                cost_usd=result_cost,
                env_id=log_env_id,
                role=log_role,
            )

        # 4. Persist cost
        if result_cost and result_cost > 0:
            try:
                _get_session_store().increment_cost(session_id, result_cost)
            except Exception:
                logger.debug("Cost persistence failed for %s", session_id, exc_info=True)

        result = ExecutionResult(
            success=True,
            session_id=session_id,
            output=result_text,
            duration_ms=duration_ms,
            cost_usd=result_cost,
            tool_calls=result_tool_calls,
        )
        holder["result"] = result.to_dict()
        return result

    except asyncio.TimeoutError:
        duration_ms = int((time.time() - start_time) * 1000)
        error_msg = f"Timeout after {duration_ms / 1000:.1f}s"
        logger.warning("Execution timeout for %s (%dms)", session_id, duration_ms)
        if session_logger:
            session_logger.log_response(
                success=False, error=error_msg, duration_ms=duration_ms,
                env_id=log_env_id, role=log_role,
            )
        result = ExecutionResult(
            success=False,
            session_id=session_id,
            error=error_msg,
            duration_ms=duration_ms,
        )
        holder["error"] = error_msg
        holder["result"] = result.to_dict()
        return result

    except asyncio.CancelledError:
        duration_ms = int((time.time() - start_time) * 1000)
        logger.warning("Execution cancelled for %s", session_id)
        result = ExecutionResult(
            success=False,
            session_id=session_id,
            error="Execution cancelled",
            duration_ms=duration_ms,
        )
        holder["error"] = "Execution cancelled"
        holder["result"] = result.to_dict()
        return result

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        logger.error("❌ Execution failed for %s: %s", session_id, e, exc_info=True)
        if session_logger:
            session_logger.log_response(
                success=False, error=str(e), duration_ms=duration_ms,
                env_id=log_env_id, role=log_role,
            )
        result = ExecutionResult(
            success=False,
            session_id=session_id,
            error=str(e),
            duration_ms=duration_ms,
        )
        holder["error"] = str(e)
        holder["result"] = result.to_dict()
        return result

    finally:
        holder["done"] = True


# ============================================================================
# Public API — synchronous (await) execution
# ============================================================================

async def execute_command(
    session_id: str,
    prompt: str,
    *,
    timeout: Optional[float] = None,
    system_prompt: Optional[str] = None,
    max_turns: Optional[int] = None,
    is_trigger: bool = False,
    **invoke_kwargs,
) -> ExecutionResult:
    """
    Execute a command synchronously (blocking until completion).

    Used by:
      - ``POST /api/agents/{id}/execute``   (command tab, synchronous)
      - Messenger ``_run_broadcast``         (each agent in the room)
      - Thinking trigger service             (is_trigger=True)

    When *is_trigger* is True the execution is tagged as preemptible:
    a subsequent user-initiated ``execute_command`` will automatically
    cancel this trigger before proceeding.

    Extra ``invoke_kwargs`` are forwarded to ``agent.invoke()`` — e.g.
    ``is_chat_message=True`` for broadcast context.

    Raises:
      AgentNotFoundError    – session does not exist
      AgentNotAliveError    – process dead, revival failed
      AlreadyExecutingError – another command is already running
    """
    logger.info(
        "[Executor:%s] execute_command called: prompt=%s, is_trigger=%s, kwargs=%s",
        session_id[:8], prompt[:80], is_trigger, list(invoke_kwargs.keys()),
    )

    # 1. Resolve & revive
    agent = await _resolve_agent(session_id)
    logger.debug("[Executor:%s] agent resolved, alive=%s", session_id[:8], agent.is_alive())

    # 1b. Record activity for VTuber thinking trigger
    #     Skip for trigger executions (would break adaptive backoff)
    if not is_trigger and getattr(agent, '_session_type', None) == 'vtuber':
        try:
            from service.vtuber.thinking_trigger import get_thinking_trigger_service
            get_thinking_trigger_service().record_activity(session_id)
        except Exception:
            pass  # best-effort

    # 2. Double-execution guard — with trigger preemption
    if is_executing(session_id):
        if not is_trigger and is_trigger_executing(session_id):
            # User message takes priority over trigger — abort the trigger
            logger.info(
                "[Executor:%s] preempting trigger for user message",
                session_id[:8],
            )
            aborted = await abort_trigger_execution(session_id)
            if not aborted:
                logger.warning("[Executor:%s] trigger preemption failed", session_id[:8])
                raise AlreadyExecutingError(
                    f"Execution already in progress for session {session_id}"
                )
            # Small yield to let cleanup propagate
            await asyncio.sleep(0)
        else:
            logger.warning(
                "[Executor:%s] already executing (is_trigger=%s, current_is_trigger=%s)",
                session_id[:8], is_trigger, is_trigger_executing(session_id),
            )
            raise AlreadyExecutingError(
                f"Execution already in progress for session {session_id}"
            )

    # 3. Register
    session_logger = _get_session_logger(session_id, create_if_missing=True)
    exec_id = uuid.uuid4().hex
    cache_cursor = session_logger.get_cache_length() if session_logger else 0
    holder: dict = {
        "done": False,
        "result": None,
        "error": None,
        "start_time": time.time(),
        "cache_cursor": cache_cursor,
        "is_trigger": is_trigger,
        "task": None,
        "exec_id": exec_id,
    }
    _active_executions[session_id] = holder
    logger.info(
        "[Executor:%s] holder registered: exec_id=%s, cache_cursor=%d",
        session_id[:8], exec_id[:8], cache_cursor,
    )

    # 4. Execute (blocking)
    try:
        # Notify linked VTuber that Sub-Worker is working (best-effort)
        await _notify_vtuber_sub_worker_progress(session_id, "executing")

        exec_task = asyncio.create_task(
            _execute_core(
                agent, session_id, prompt, holder,
                timeout=timeout,
                system_prompt=system_prompt,
                max_turns=max_turns,
                **invoke_kwargs,
            )
        )
        holder["task"] = exec_task

        result = await exec_task

        # 5. Emit avatar state (best-effort, never raises)
        await _emit_avatar_state(session_id, result)
        # 6. Notify linked VTuber if this is a Sub-Worker (best-effort)
        await _notify_linked_vtuber(session_id, result)

        return result
    except asyncio.CancelledError:
        # This execution was preempted by a higher-priority command
        duration_ms = int((time.time() - holder["start_time"]) * 1000)
        logger.info(
            "Execution preempted for %s (is_trigger=%s, %dms)",
            session_id, is_trigger, duration_ms,
        )
        return ExecutionResult(
            success=False,
            session_id=session_id,
            error="Preempted by user message",
            duration_ms=duration_ms,
        )
    finally:
        # Cleanup — only remove our own holder (exec_id guard prevents
        # accidentally removing a newer execution's holder).
        cleanup_execution(session_id, exec_id=exec_id)

        # 7. Post-execution inbox drain (fire-and-forget, best-effort)
        #    Runs after EVERY execution (including thinking triggers).
        #    Without this the Worker→VTuber [SUB_WORKER_RESULT] queued
        #    via `_notify_linked_vtuber`'s inbox fallback would only be
        #    drained when the user sent a fresh message — leaving the
        #    VTuber narrating "still waiting" while the result sits in
        #    the inbox. Re-entry is prevented by the `_draining_sessions`
        #    guard inside `_drain_inbox`; the drain itself invokes
        #    `execute_command` *without* `is_trigger=True`, so the
        #    drain's child execution can in turn drain again only after
        #    the guard releases at the outer drain's `finally`.
        if session_id not in _draining_sessions:
            asyncio.create_task(_drain_inbox(session_id))


# ============================================================================
# Post-execution inbox drain
# ============================================================================

async def _drain_inbox(session_id: str) -> None:
    """
    After an execution completes, consume unread inbox messages one at a
    time and feed them back through ``execute_command``. Messages are
    marked read at pull time (consumed-on-pull), so a deterministic
    processing failure cannot loop — the message is lost but the drain
    does not spin.

    Ordering: each pull + synthesised turn runs serially under the
    ``_draining_sessions`` guard. The existing ``AlreadyExecutingError``
    is the backstop against concurrent execution (the winning caller's
    own finally block will re-invoke this drain).
    """
    if session_id in _draining_sessions:
        return

    try:
        from service.chat.inbox import get_inbox_manager
    except Exception:
        logger.debug("Inbox import failed for %s drain", session_id, exc_info=True)
        return

    inbox = get_inbox_manager()
    _draining_sessions.add(session_id)
    sl = _get_session_logger(session_id, create_if_missing=False)
    n_ok = 0
    n_err = 0
    n_dedup = 0
    started = False
    # Cycle 20260430_1 P1-2 — per-drain dedupe set. Captures
    # (sender_session_id, tag) pairs already processed in this drain so
    # repeated auto-fallback notifications (each carrying
    # tag="[SUB_WORKER_RESULT]") do not feed the VTuber the same empty
    # narration twice. The set is local to this drain pass, so
    # genuinely-fresh delegation cycles in later drains start clean.
    seen_tag_keys: Set[tuple] = set()
    try:
        while True:
            try:
                pulled = inbox.pull_unread(session_id, limit=1)
            except Exception:
                logger.debug(
                    "Inbox pull failed for %s", session_id, exc_info=True,
                )
                return
            if not pulled:
                return
            msg = pulled[0]

            if not started and sl is not None:
                sl.log(
                    level=LogLevel.INFO,
                    message="Draining inbox",
                    metadata={"event": "inbox.drain.start"},
                )
                started = True

            sender = msg.get("sender_name") or "Unknown"
            metadata = msg.get("metadata") or {}
            tag = metadata.get("tag") if isinstance(metadata, dict) else None
            if tag:
                key = (msg.get("sender_session_id") or "", tag)
                if key in seen_tag_keys:
                    n_dedup += 1
                    if sl is not None:
                        sl.log(
                            level=LogLevel.INFO,
                            message=(
                                f"Inbox drain skipped duplicate "
                                f"{tag} from {sender}"
                            ),
                            metadata={
                                "event": "inbox.drain.deduped",
                                "sender": sender,
                                "tag": tag,
                            },
                        )
                    logger.info(
                        "Drain dedupe %s: skipped %s from %s (msg=%s)",
                        session_id, tag, sender, msg.get("id"),
                    )
                    continue
                seen_tag_keys.add(key)

            prompt = f"[INBOX from {sender}]\n{msg['content']}"
            logger.info(
                "Draining inbox msg %s for %s (sender=%s, tag=%s)",
                msg.get("id"), session_id, sender, tag,
            )

            try:
                result = await execute_command(session_id, prompt)
            except AlreadyExecutingError:
                # A concurrent execution took the slot. Its finally
                # block will re-trigger drain; bail to avoid racing.
                logger.debug(
                    "Drain for %s yielded to concurrent execution",
                    session_id,
                )
                return
            except Exception as drain_err:
                logger.debug(
                    "Drained execute_command failed for %s",
                    session_id, exc_info=True,
                )
                n_err += 1
                if sl is not None:
                    sl.log(
                        level=LogLevel.WARNING,
                        message=f"Inbox drain item failed: {drain_err}",
                        metadata={
                            "event": "inbox.drain.item_failed",
                            "sender": sender,
                            "error": str(drain_err),
                        },
                    )
                # Message already consumed — skip to next one.
                continue

            n_ok += 1
            if sl is not None:
                sl.log(
                    level=LogLevel.INFO,
                    message=f"Replayed inbox message from {sender}",
                    metadata={
                        "event": "inbox.drain.item_ok",
                        "sender": sender,
                    },
                )

            if result.success and result.output and result.output.strip():
                _save_drain_to_chat_room(session_id, result)
    finally:
        _draining_sessions.discard(session_id)
        if started and sl is not None:
            sl.log(
                level=LogLevel.INFO,
                message=(
                    f"Drain complete: {n_ok} ok, {n_err} failed, "
                    f"{n_dedup} deduped"
                ),
                metadata={
                    "event": "inbox.drain.complete",
                    "n_ok": n_ok,
                    "n_err": n_err,
                    "n_dedup": n_dedup,
                },
            )


def _save_subworker_reply_to_chat_room(
    vtuber_session_id: str,
    result: 'ExecutionResult',
) -> None:
    """Post the VTuber's reply to the user's chat room.

    Mirrors :func:`_save_drain_to_chat_room` /
    :meth:`ThinkingTriggerService._save_to_chat_room` for the
    Sub-Worker → VTuber auto-report pathway. Without this the VTuber's
    response to ``[SUB_WORKER_RESULT]`` is generated (and even costed)
    but never reaches the panel the user is watching — cycle 20260420_8
    Bug 2a.

    Best-effort: never raises. Noop when the VTuber has no
    ``_chat_room_id`` (solo session, pre-binding state, etc.) or when
    the VTuber produced no meaningful output (empty string, failure).
    """
    try:
        from service.utils.text_sanitizer import sanitize_for_display
        cleaned = sanitize_for_display(result.output) if result.success else ""
        if not cleaned:
            return

        agent = _get_agent_manager().get_agent(vtuber_session_id)
        if agent is None:
            return

        chat_room_id = getattr(agent, '_chat_room_id', None)
        if not chat_room_id:
            logger.debug(
                "VTuber %s has no _chat_room_id; skipping sub-worker reply broadcast",
                vtuber_session_id,
            )
            return

        from service.chat.conversation_store import get_chat_store
        store = get_chat_store()

        session_name = getattr(agent, '_session_name', None) or vtuber_session_id
        role_val = getattr(agent, '_role', None)
        role = role_val.value if hasattr(role_val, 'value') else str(role_val or 'vtuber')

        msg = store.add_message(chat_room_id, {
            "type": "agent",
            "content": cleaned,
            "session_id": vtuber_session_id,
            "session_name": session_name,
            "role": role,
            "duration_ms": result.duration_ms,
            "cost_usd": result.cost_usd,
            "source": "sub_worker_reply",
        })

        logger.info(
            "[SubWorkerReply] Posted VTuber response to chat room %s "
            "(msg_id=%s, len=%d)",
            chat_room_id, msg.get("id", "?"), len(cleaned),
        )

        try:
            from controller.chat_controller import _notify_room
            _notify_room(chat_room_id)
        except Exception:
            logger.warning(
                "[SubWorkerReply] _notify_room failed for %s",
                chat_room_id, exc_info=True,
            )
    except Exception:
        logger.warning(
            "[SubWorkerReply] Failed to post VTuber reply to chat room",
            exc_info=True,
        )


def _save_drain_to_chat_room(session_id: str, result: 'ExecutionResult') -> None:
    """
    Save an inbox-drain execution result to the session's chat room.
    Similar to ThinkingTriggerService._save_to_chat_room but usable
    from agent_executor without circular dependency.
    """
    try:
        from service.utils.text_sanitizer import sanitize_for_display
        cleaned = sanitize_for_display(result.output) if result.success else ""
        if not cleaned:
            return

        agent_manager = _get_agent_manager()
        agent = agent_manager.get_agent(session_id)
        if not agent:
            return

        chat_room_id = getattr(agent, '_chat_room_id', None)
        if not chat_room_id:
            return

        from service.chat.conversation_store import get_chat_store
        store = get_chat_store()

        session_name = getattr(agent, '_session_name', None) or session_id
        role_val = getattr(agent, '_role', None)
        role = role_val.value if hasattr(role_val, 'value') else str(role_val or 'worker')

        store.add_message(chat_room_id, {
            "type": "agent",
            "content": cleaned,
            "session_id": session_id,
            "session_name": session_name,
            "role": role,
            "duration_ms": result.duration_ms,
            "cost_usd": result.cost_usd,
            # TTS-fix (2026-04-26): tag the source so the frontend can
            # suppress auto-TTS for inbox-drain outputs (the user
            # didn't initiate this turn). Mirrors the
            # ``thinking_trigger`` / ``sub_worker_reply`` markers.
            "source": "inbox_drain",
        })

        # Notify SSE listeners
        try:
            from controller.chat_controller import _notify_room
            _notify_room(chat_room_id)
        except Exception:
            pass

        logger.info(
            "Inbox drain result saved to chat room %s (len=%d)",
            chat_room_id, len(cleaned),
        )
    except Exception:
        logger.debug("Failed to save drain result to chat room", exc_info=True)


# ============================================================================
# Public API — background execution (non-blocking, returns holder)
# ============================================================================

async def start_command_background(
    session_id: str,
    prompt: str,
    *,
    timeout: Optional[float] = None,
    system_prompt: Optional[str] = None,
    max_turns: Optional[int] = None,
) -> dict:
    """
    Start command execution in the background.  Returns the *holder*
    dict immediately.

    Used by:
      - ``POST /api/agents/{id}/execute/start``  (two-step SSE)
      - ``POST /api/agents/{id}/execute/stream``  (single SSE)

    The SSE streaming loop in the controller polls
    ``holder["done"]`` and ``session_logger.get_cache_entries_since()``
    to stream real-time log events.

    The caller is responsible for calling ``cleanup_execution()``
    when the SSE stream ends.

    Raises:
      AgentNotFoundError    – session does not exist
      AgentNotAliveError    – process dead, revival failed
      AlreadyExecutingError – another command is already running
    """
    logger.info(
        "[Executor:%s] start_command_background called: prompt=%s, timeout=%s",
        session_id[:8], prompt[:80], timeout,
    )

    # 1. Resolve & revive
    agent = await _resolve_agent(session_id)
    logger.debug("[Executor:%s] (bg) agent resolved, alive=%s", session_id[:8], agent.is_alive())

    # 1b. Record activity for VTuber thinking trigger
    if getattr(agent, '_session_type', None) == 'vtuber':
        try:
            from service.vtuber.thinking_trigger import get_thinking_trigger_service
            get_thinking_trigger_service().record_activity(session_id)
        except Exception:
            pass

    # 2. Double-execution guard — with trigger preemption
    if is_executing(session_id):
        if is_trigger_executing(session_id):
            logger.info("[Executor:%s] (bg) preempting trigger", session_id[:8])
            aborted = await abort_trigger_execution(session_id)
            if not aborted:
                logger.warning("[Executor:%s] (bg) trigger preemption failed", session_id[:8])
                raise AlreadyExecutingError(
                    f"Execution already in progress for session {session_id}"
                )
            await asyncio.sleep(0)
        else:
            logger.warning("[Executor:%s] (bg) already executing", session_id[:8])
            raise AlreadyExecutingError(
                f"Execution already in progress for session {session_id}"
            )

    # 3. Register
    session_logger = _get_session_logger(session_id, create_if_missing=True)
    exec_id = uuid.uuid4().hex
    cache_cursor = session_logger.get_cache_length() if session_logger else 0
    holder: dict = {
        "done": False,
        "result": None,
        "error": None,
        "start_time": time.time(),
        "cache_cursor": cache_cursor,
        "is_trigger": False,
        "task": None,
        "exec_id": exec_id,
    }
    _active_executions[session_id] = holder
    logger.info(
        "[Executor:%s] (bg) holder registered: exec_id=%s, cache_cursor=%d",
        session_id[:8], exec_id[:8], cache_cursor,
    )

    # 4. Fire-and-forget background task
    async def _run():
        try:
            result = await _execute_core(
                agent, session_id, prompt, holder,
                timeout=timeout,
                system_prompt=system_prompt,
                max_turns=max_turns,
            )
            # Emit avatar state (best-effort)
            await _emit_avatar_state(session_id, result)
            # Notify linked VTuber if this is a Sub-Worker (best-effort)
            await _notify_linked_vtuber(session_id, result)
        finally:
            # Schedule deferred cleanup: keep the holder alive for a grace
            # period so a reconnecting frontend can pick up the final result,
            # then remove it to prevent memory leaks.
            async def _deferred_cleanup():
                from service.config.sub_config.general.chat_config import ChatConfig
                _chat_cfg = ChatConfig.get_default_instance()
                await asyncio.sleep(_chat_cfg.holder_grace_period_s)
                cleanup_execution(session_id, exec_id=exec_id)

            asyncio.create_task(_deferred_cleanup())

            # Post-execution inbox drain
            if session_id not in _draining_sessions:
                asyncio.create_task(_drain_inbox(session_id))

    asyncio.create_task(_run())
    return holder
