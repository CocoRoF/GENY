"""SubagentType seed for Geny.

Three descriptors out of the box:

* ``worker``           — general-purpose, full default toolset
* ``researcher``       — read-only investigation (no write/edit/bash)
* ``vtuber-narrator``  — VTuber persona for short narrations

Hosts add more by extending DESCRIPTORS or calling
``install_subagent_types`` with their own list.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

# Importing the executor side at module top-level so we surface
# ImportError (1.1.0 not installed) immediately rather than hiding
# it behind try/except.
try:  # pragma: no cover — covered by e2e environment, not unit
    from geny_executor.stages.s12_agent.subagent_type import (
        SubagentTypeDescriptor,
        SubagentTypeRegistry,
    )
except ImportError:  # pragma: no cover — only triggers on stale exec
    SubagentTypeDescriptor = None  # type: ignore[assignment]
    SubagentTypeRegistry = None  # type: ignore[assignment]


def _make_descriptors() -> List[Any]:
    """Build the descriptor list lazily so test environments without
    geny-executor installed still import this module."""
    if SubagentTypeDescriptor is None:
        return []
    return [
        SubagentTypeDescriptor(
            agent_type="worker",
            description=(
                "General-purpose worker. Full default toolset (Read / Write / "
                "Edit / Bash / Grep / Glob / NotebookEdit / WebFetch)."
            ),
        ),
        SubagentTypeDescriptor(
            agent_type="researcher",
            description=(
                "Read-only investigation. Read / Grep / Glob / WebFetch / "
                "WebSearch only — no write/edit/bash so research can't "
                "accidentally mutate state."
            ),
        ),
        SubagentTypeDescriptor(
            agent_type="vtuber-narrator",
            description=(
                "VTuber persona for short stream narrations. Memory + "
                "Knowledge tools only."
            ),
        ),
    ]


DESCRIPTORS = _make_descriptors()


def install_subagent_types(
    registry: Optional[Any] = None,
    *,
    extra: Optional[List[Any]] = None,
) -> int:
    """Register Geny's seed descriptors into ``registry``. Returns the
    count registered.

    When ``registry`` is None, this is a no-op so callers can guard
    on the strategy slot being wired without raising.
    """
    if registry is None:
        return 0
    descriptors = list(DESCRIPTORS) + list(extra or [])
    for d in descriptors:
        try:
            registry.register(d)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "subagent_type_registration_failed",
                extra={"agent_type": getattr(d, "agent_type", "?"), "error": str(exc)},
            )
            continue
    return len(descriptors)
