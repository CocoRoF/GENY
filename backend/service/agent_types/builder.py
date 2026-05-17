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

from service.agent_types.registry import DESCRIPTORS, install_subagent_types

logger = logging.getLogger(__name__)


__all__ = ["SubagentRegistryBuilder"]


class SubagentRegistryBuilder:
    """Build a fresh :class:`SubagentTypeRegistry` per session.

    Reads the static :data:`DESCRIPTORS` seed produced by
    :mod:`service.agent_types.registry`. Hosts can pass ``extra=`` to
    layer in custom descriptors without mutating the module-level
    seed list.
    """

    def __init__(self, extra: Optional[List[Any]] = None) -> None:
        self._extra = list(extra or [])

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
        count = install_subagent_types(reg, extra=self._extra)
        logger.debug("subagent_registry_builder: registered %d descriptors", count)
        return reg
