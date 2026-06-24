"""Wire the geny-executor persistent SubAgentManager into Geny.

geny-executor 2.7.0 ships the persistent **sub-agent** primitive (owned,
autonomous, notify-on-completion) plus the inbox/notification mechanism.
Geny is a pure consumer: it constructs one ``SubAgentManager`` at boot,
hands it the same agent-type registry the orchestrator uses, and wires an
``on_event`` callback that mirrors sub-agent lifecycle into the background
task registry — so an assigned sub-agent task shows up in the 작업(Tasks)
tab (running → done/failed), scoped to the owning session.

The manager is injected into each session's ``ToolContext.extras`` (see
``AgentSession._build_pipeline``) so the SubAgent* tools function.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _make_on_event(app_state: Any):
    """Build the lifecycle→task-registry mirror callback.

    Surfaces persistent sub-agent assignments as background-task records so
    the existing 작업 tab (session-scoped) renders them. The sub-agent runs
    inside the executor, NOT the task runner — these are *mirror* records
    (registered + status-updated directly), never re-executed.
    """

    def _on_event(event_type: str, payload: Dict[str, Any]) -> None:
        registry = getattr(app_state, "task_registry", None)
        if registry is None:
            return
        try:
            from geny_executor.stages.s13_task_registry import TaskRecord, TaskStatus

            if event_type == "subagent.assigned":
                assignment_id = payload.get("assignment_id")
                if not assignment_id:
                    return
                registry.register(
                    TaskRecord(
                        task_id=assignment_id,
                        kind="subagent",
                        payload={
                            "_session_id": payload.get("owner_session_id"),
                            "sub_agent_id": payload.get("sub_agent_id"),
                            "agent_type": payload.get("agent_type"),
                            "task": payload.get("task"),
                        },
                    )
                )
                registry.update_status(assignment_id, TaskStatus.RUNNING)
            elif event_type == "subagent.completed":
                aid = payload.get("assignment_id")
                if aid:
                    registry.update_status(
                        aid, TaskStatus.DONE, result=payload.get("text")
                    )
                _maybe_alarm_vtuber(payload, ok=True)
            elif event_type == "subagent.failed":
                aid = payload.get("assignment_id")
                if aid:
                    registry.update_status(
                        aid, TaskStatus.FAILED, error=payload.get("error")
                    )
                _maybe_alarm_vtuber(payload, ok=False)
            elif event_type == "subagent.stopped":
                # The manager stops by sub_agent_id (no assignment_id) — mark any
                # of this sub-agent's still-running mirror tasks as cancelled.
                sid = payload.get("sub_agent_id")
                if sid:
                    for rec in registry.list_all():
                        if (
                            rec.kind == "subagent"
                            and not getattr(rec, "is_terminal", False)
                            and (rec.payload or {}).get("sub_agent_id") == sid
                        ):
                            registry.update_status(
                                rec.task_id, TaskStatus.CANCELLED, error="sub-agent stopped"
                            )
        except Exception:  # noqa: BLE001 — surfacing must never break a run
            logger.debug(
                "subagent on_event mirror failed (%s)", event_type, exc_info=True
            )

    return _on_event


def _maybe_alarm_vtuber(payload: Dict[str, Any], *, ok: bool) -> None:
    """Proactively wake the OWNER when its OWNED sub-agent finishes (the alarm).

    Env-driven, not role-driven: the proactive wake fires only for the owner's
    *owned* persistent companion (deterministic id ``{owner}-subagent``) — the
    conversational delegate an env declares. Sub-agents a session spawned ad-hoc
    via the SubAgent* tools are NOT proactively woken; that owner pulls results
    via SubAgentInboxRead. Best-effort; never raises.
    """
    owner = payload.get("owner_session_id")
    sender = payload.get("sub_agent_id")
    if not owner or not sender:
        return
    try:
        from service.vtuber.sub_agent_bridge import owned_subagent_id

        # Only the owned companion triggers a proactive wake.
        if sender != owned_subagent_id(owner):
            return

        text = payload.get("text") if ok else payload.get("error")
        tag = "[SUB_AGENT_RESULT]"
        body = (
            f"{tag} Sub-agent task completed.\n\n{text}" if ok
            else f"{tag} Sub-agent task failed: {str(text)[:500]}"
        )

        import asyncio

        async def _wake() -> None:
            # Try to wake the VTuber immediately; if it's busy, queue to the
            # general Geny inbox so the existing _drain_inbox delivers it on
            # the VTuber's next idle — same busy-safe path the bespoke notify
            # used (reused general infra, not bespoke-specific).
            try:
                from service.execution.agent_executor import (
                    execute_command,
                    _save_drain_to_chat_room,
                    AlreadyExecutingError,
                )

                try:
                    # Run the owner's reaction turn AND surface its reply in the
                    # chat room — execute_command alone only runs the turn (the
                    # reply stayed in the log and the VTuber never "spoke"). The
                    # busy path below already broadcasts via _drain_inbox →
                    # _save_drain_to_chat_room; mirror it here for the direct path.
                    result = await execute_command(session_id=owner, prompt=body)
                    _save_drain_to_chat_room(owner, result, source="subagent_result")
                except AlreadyExecutingError:
                    from service.chat.inbox import get_inbox_manager

                    get_inbox_manager().deliver(
                        target_session_id=owner,
                        content=body,
                        sender_session_id=sender,
                        sender_name="Sub-Agent",
                        metadata={"tag": tag, "source": "subagent_alarm_busy"},
                    )
                    logger.info("VTuber %s busy — sub-agent result queued to inbox", owner)
            except Exception:  # noqa: BLE001 — best effort
                logger.debug("VTuber sub-agent alarm failed", exc_info=True)

        try:
            asyncio.get_running_loop().create_task(_wake())
        except RuntimeError:
            logger.debug("no running loop for VTuber sub-agent alarm")
    except Exception:  # noqa: BLE001
        logger.debug("_maybe_alarm_vtuber failed", exc_info=True)


def install_subagent_manager(app_state: Any, *, registry: Any) -> Optional[Any]:
    """Construct + return the SubAgentManager, or ``None`` if unavailable.

    Args:
        app_state: FastAPI app.state (for task_registry access in on_event).
        registry: the shared SubagentTypeRegistry (same one the global
            orchestrator uses).
    """
    if registry is None:
        return None
    try:
        from geny_executor.stages.s12_agent.persistent_subagent import (
            SubAgentManager,
        )
    except ImportError:
        logger.debug("install_subagent_manager: executor lacks persistent_subagent (<2.7.0)")
        return None

    # Restart survival: persist each sub-agent's PipelineState under the same
    # storage root sessions use ({root}/{sub_agent_id}/.pipeline_state.json),
    # reusing the executor's own FileSessionPersistence (its load/save shape
    # matches the SubAgentManager session_store contract).
    session_store = None
    try:
        from geny_executor.session import FileSessionPersistence
        from service.utils.platform import DEFAULT_STORAGE_ROOT

        session_store = FileSessionPersistence(str(DEFAULT_STORAGE_ROOT))
    except Exception:  # noqa: BLE001 — fall back to in-process-only persistence
        logger.debug("install_subagent_manager: session_store unavailable", exc_info=True)

    manager = SubAgentManager(
        registry,
        session_store=session_store,
        on_event=_make_on_event(app_state),
    )
    logger.info(
        "   ✅ subagent_manager wired (persistent sub-agents%s)",
        " + durable state" if session_store is not None else "",
    )
    return manager


__all__ = ["install_subagent_manager"]
