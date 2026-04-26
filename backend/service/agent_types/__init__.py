"""Geny's seed of SubagentType descriptors (PR-A.5.1).

This package only registers descriptors; the actual orchestration
logic lives in ``geny_executor.stages.s12_agent``. Hosts that want
different subagent_types swap this seed without touching framework
code.
"""

from service.agent_types.registry import DESCRIPTORS, install_subagent_types

__all__ = ["DESCRIPTORS", "install_subagent_types"]
