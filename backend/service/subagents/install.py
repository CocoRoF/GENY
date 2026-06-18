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
            elif event_type == "subagent.failed":
                aid = payload.get("assignment_id")
                if aid:
                    registry.update_status(
                        aid, TaskStatus.FAILED, error=payload.get("error")
                    )
        except Exception:  # noqa: BLE001 — surfacing must never break a run
            logger.debug(
                "subagent on_event mirror failed (%s)", event_type, exc_info=True
            )

    return _on_event


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

    manager = SubAgentManager(registry, on_event=_make_on_event(app_state))
    logger.info("   ✅ subagent_manager wired (persistent sub-agents available)")
    return manager


__all__ = ["install_subagent_manager"]
