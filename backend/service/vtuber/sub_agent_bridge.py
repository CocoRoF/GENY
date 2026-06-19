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


#: Memory-dependent stages deactivated in the companion (it has no
#: session-level memory provider; conversation continuity comes from the
#: SubAgentManager's persisted state instead).
_MEMORY_STAGE_ORDERS = (2, 18, 19, 20)  # context / memory / summarize / persist
_AGENT_STAGE_ORDER = 12


def _make_parent_env_companion_factory(env_service: Any, parent_env_id: str):
    """Build a PipelineFactory that clones the PARENT agent's environment.

    The companion inherits the parent env's tools / model / provider / stages
    (decision: "부모 env 기능 그대로") — NO separate env. We only (a) deactivate
    the memory-dependent stages (no session memory provider is wired for the
    companion), and (b) force Stage-12 to single_agent so the companion can't
    recursively spawn further sub-agents. The companion's system prompt
    (``ctx.descriptor.system_prompt``) is applied via attach_runtime.
    """

    async def _factory(ctx: Any) -> Any:
        from geny_executor import EnvironmentManifest, Pipeline

        base = env_service.load_manifest(parent_env_id)
        if base is None:
            raise RuntimeError(f"parent env not found for companion: {parent_env_id}")
        # Clone so we never mutate the cached parent manifest.
        manifest = EnvironmentManifest.from_dict(base.to_dict())
        entries = manifest.stage_entries()
        for e in entries:
            if e.order in _MEMORY_STAGE_ORDERS:
                e.active = False
            if e.order == _AGENT_STAGE_ORDER:
                e.strategies = {**(e.strategies or {}), "orchestrator": "single_agent"}
        try:
            manifest.set_stage_entries(entries)
        except Exception:  # noqa: BLE001 — in-place mutation already applied
            pass

        pipeline = await Pipeline.from_manifest_async(
            manifest, credentials=ctx.credentials, strict=False,
        )
        # Role prompt: the env editor's override when set, otherwise the
        # library's strong default companion persona (executor >=2.8.0). Either
        # way the companion runs with an explicit "autonomous delegate" role on
        # top of the inherited parent env.
        system_prompt = getattr(ctx.descriptor, "system_prompt", None)
        if not system_prompt:
            try:
                from geny_executor.stages.s12_agent.subagent_catalog import (
                    DEFAULT_PERSISTENT_SUBAGENT_PROMPT,
                )

                system_prompt = DEFAULT_PERSISTENT_SUBAGENT_PROMPT
            except Exception:  # noqa: BLE001 — executor < 2.8.0
                system_prompt = None
        if system_prompt:
            try:
                from geny_executor.stages.s03_system.artifact.default.builders import (
                    ComposablePromptBuilder,
                    PersonaBlock,
                )

                pipeline.attach_runtime(
                    system_builder=ComposablePromptBuilder(
                        blocks=[PersonaBlock(system_prompt)]
                    ),
                )
            except Exception:  # noqa: BLE001
                logger.warning("companion: system_prompt attach failed", exc_info=True)
        return pipeline

    return _factory


async def spawn_owned_subagent(
    app_state: Any,
    owner_session_id: str,
    *,
    parent_env_id: str,
    env_service: Any,
    system_prompt: Optional[str] = None,
    credentials: Any = None,
    parent_provider: Optional[str] = None,
) -> Optional[str]:
    """Spawn the persistent sub-agent an env-declaring agent owns.

    The companion is built from the PARENT agent's environment (it inherits the
    parent's tools / model / stages — no separate env), with an optional
    ``system_prompt`` role override. Returns the sub-agent id, or None when no
    SubAgentManager is wired / spawn fails."""
    manager = getattr(app_state, "subagent_manager", None)
    if manager is None or env_service is None:
        return None
    sub_agent_id = owned_subagent_id(owner_session_id)
    try:
        factory = _make_parent_env_companion_factory(env_service, parent_env_id)
        await manager.spawn(
            "owned",
            owner_session_id,
            factory=factory,
            sub_agent_id=sub_agent_id,
            credentials=credentials,
            parent_provider=parent_provider,
            system_prompt=system_prompt or None,
        )
        logger.info(
            "[%s] 🤖 owned sub-agent spawned: %s (parent env=%s, prompt=%s)",
            owner_session_id, sub_agent_id, parent_env_id,
            "custom" if system_prompt else "default",
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
