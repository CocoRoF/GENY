"""Build a :class:`SubagentTypeRegistry` from Geny's seed descriptors.

Phase E1 of the LLM backend upgrade cycle. Thin builder that
``AgentSessionManager`` will call once per session to produce the
registry handed to ``Pipeline.from_manifest_async(subagent_registry=)``.

Sub-pipeline factories themselves are still placeholders here. Phase
E3 wires real factories that build sub-manifests using the parent's
``CredentialBundle`` (already plumbed via ``SubAgentBuildContext`` in
geny-executor 2.0.0).
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

from service.agent_types.registry import (
    DESCRIPTORS,
    build_descriptor_from_config,
)

logger = logging.getLogger(__name__)


__all__ = ["SubagentRegistryBuilder"]


class SubagentRegistryBuilder:
    """Build a fresh :class:`SubagentTypeRegistry` per session.

    Starts from the :data:`DESCRIPTORS` seed, then overlays the env's precise
    Sub-Worker roster (``env_overrides`` — the env editor's
    ``host_selections.extras.subworker_types``). Each override entry, keyed by
    ``agent_type``:

    * ``enabled: false`` → the type is removed from this env's roster.
    * otherwise → its precise config (description / provider / model /
      system_prompt / allowed_tools) replaces the seed type, or adds a brand
      new type. The one-shot sub-worker the agent spawns via the Agent tool
      then runs with exactly that config.

    ``extra=`` layers in pre-built descriptors (kept for back-compat).
    """

    def __init__(
        self,
        extra: Optional[List[Any]] = None,
        *,
        env_overrides: Optional[List[Any]] = None,
    ) -> None:
        self._extra = list(extra or [])
        self._env_overrides = [
            c
            for c in (env_overrides or [])
            if isinstance(c, dict) and c.get("agent_type")
        ]

    def build(self) -> Optional[Any]:
        """Return a fresh registry, or ``None`` when geny-executor is
        not importable (defensive — should not happen once the
        dependency is pinned to >=2.0.0)."""
        try:
            from geny_executor.stages.s12_agent.subagent_type import (
                SubagentTypeRegistry,
            )
        except ImportError:  # pragma: no cover — see registry.py top-level guard
            logger.warning("subagent_registry_builder: geny_executor not importable")
            return None

        reg = SubagentTypeRegistry()
        overrides = {str(c["agent_type"]): c for c in self._env_overrides}
        disabled = {at for at, c in overrides.items() if c.get("enabled") is False}
        registered: set[str] = set()

        # 1. Env-declared precise overrides win (register first).
        for at, cfg in overrides.items():
            if at in disabled:
                continue
            d = build_descriptor_from_config(cfg)
            if d is None:
                continue
            try:
                reg.register(d)
                registered.add(at)
            except Exception as exc:  # noqa: BLE001
                logger.warning("subagent override register failed %s: %s", at, exc)

        # 2. Seed defaults + extras for types neither overridden nor disabled.
        for d in list(DESCRIPTORS) + self._extra:
            at = str(getattr(d, "agent_type", ""))
            if not at or at in registered or at in disabled:
                continue
            try:
                reg.register(d)
                registered.add(at)
            except Exception as exc:  # noqa: BLE001
                logger.warning("subagent seed register failed %s: %s", at, exc)

        logger.debug(
            "subagent_registry_builder: %d types (%d env overrides, %d disabled)",
            len(registered), len(overrides) - len(disabled), len(disabled),
        )
        return reg
