"""VTuber → executor persistent sub-agent bridge (flag-gated cutover).

Decision 3 of the consolidation plan: the VTuber should *own an executor
sub-agent* instead of Geny's bespoke paired Sub-Worker session. This is the
highest-risk migration (the bespoke path is deeply integrated), so it is
gated behind a flag and ships **default OFF** — existing VTubers keep using
the bespoke pairing with zero behaviour change until an operator opts in and
validates.

Mode resolution (first wins):
  * env ``GENY_VTUBER_SUBAGENT_MODE`` = ``executor`` | ``bespoke``
  * settings ``vtuber.sub_worker.mode``
  * default ``bespoke``

When ``executor``:
  * VTuber-create spawns a persistent sub-agent it owns (via the executor
    ``SubAgentManager``) instead of the bespoke paired session.
  * ``send_direct_message_internal`` routes to ``SubAgentAssign`` (the
    VTuber fully delegates; the sub-agent completes autonomously).
  * completion lands in the VTuber's inbox; Geny surfaces it as the alarm
    (``[SUB_AGENT_RESULT]``) via the existing execute path.

Remaining for full cutover (tracked): view-only UI for the non-session
sub-agent, live parity validation, then flip default + remove bespoke.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

_MODE_ENV = "GENY_VTUBER_SUBAGENT_MODE"
_VALID_MODES = ("bespoke", "executor")
#: agent-type the VTuber's owned sub-agent is built from.
DEFAULT_SUBAGENT_TYPE = "worker"


#: Default mode. Flipped to ``executor`` at the cutover (2026-06-18): the
#: VTuber now owns a geny-executor persistent sub-agent. ``bespoke`` remains
#: selectable via the flag for emergency rollback until the bespoke code is
#: fully removed.
_DEFAULT_MODE = "executor"


def vtuber_subagent_mode() -> str:
    """Resolve the VTuber sub-agent mode. Default ``executor`` (cutover)."""
    raw = (os.environ.get(_MODE_ENV) or "").strip().lower()
    if raw in _VALID_MODES:
        return raw
    try:
        from service.settings.sections import VTuberSubWorkerSection  # noqa: F401
        from geny_executor.settings import get_default_loader

        section = get_default_loader().get_section("vtuber")
        sub = getattr(section, "sub_worker", None) if section is not None else None
        mode = getattr(sub, "mode", None) if sub is not None else None
        if isinstance(mode, str) and mode.strip().lower() in _VALID_MODES:
            return mode.strip().lower()
    except Exception:  # noqa: BLE001 — settings optional; fall back to default
        pass
    return _DEFAULT_MODE


def executor_mode_active(app_state: Any) -> bool:
    """True only when executor mode is selected AND a manager is wired."""
    return (
        vtuber_subagent_mode() == "executor"
        and getattr(app_state, "subagent_manager", None) is not None
    )


def owned_subagent_id(owner_session_id: str) -> str:
    """Deterministic id for the persistent sub-agent an owner owns."""
    return f"{owner_session_id}-subagent"


async def spawn_owned_subagent(
    app_state: Any,
    owner_session_id: str,
    *,
    agent_type: str = DEFAULT_SUBAGENT_TYPE,
    credentials: Any = None,
    parent_provider: Optional[str] = None,
) -> Optional[str]:
    """Spawn the persistent sub-agent an env-declaring agent owns.

    Env-driven (not role-driven): called when the agent's env declares
    ``host_selections.extras['owned_subagent']``. Returns the sub-agent id,
    or None when no SubAgentManager is wired / spawn fails."""
    manager = getattr(app_state, "subagent_manager", None)
    if manager is None:
        return None
    sub_agent_id = owned_subagent_id(owner_session_id)
    try:
        await manager.spawn(
            agent_type,
            owner_session_id,
            sub_agent_id=sub_agent_id,
            credentials=credentials,
            parent_provider=parent_provider,
        )
        logger.info(
            "[%s] 🤖 owned sub-agent spawned: %s (type=%s)",
            owner_session_id, sub_agent_id, agent_type,
        )
        return sub_agent_id
    except Exception:  # noqa: BLE001 — never fail create on this
        logger.warning(
            "[%s] owned sub-agent spawn failed", owner_session_id, exc_info=True,
        )
        return None


async def delegate_to_subagent(
    app_state: Any, sub_agent_id: str, content: str
) -> dict:
    """Fully delegate *content* to the VTuber's owned sub-agent (autonomous)."""
    manager = getattr(app_state, "subagent_manager", None)
    if manager is None:
        return {"error": "subagent_manager not available"}
    out = await manager.assign(sub_agent_id, content, background=True)
    return out


__all__ = [
    "vtuber_subagent_mode",
    "executor_mode_active",
    "spawn_owned_subagent",
    "owned_subagent_id",
    "delegate_to_subagent",
    "DEFAULT_SUBAGENT_TYPE",
]
