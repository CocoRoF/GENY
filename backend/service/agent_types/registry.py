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


# Phase E1 — seeds gain a ``provider`` slot so the multi-provider
# sub-agent path in geny-executor 2.0.0 can route each sub-agent to
# the right LLM backend. ``provider=None`` means "inherit parent".
_SEED = (
    (
        "worker",
        "General-purpose worker. Full default toolset (Read / Write / "
        "Edit / Bash / Grep / Glob / NotebookEdit / WebFetch).",
        None,                           # inherit parent provider
    ),
    (
        "researcher",
        "Read-only investigation. Read / Grep / Glob / WebFetch / "
        "WebSearch only — no write/edit/bash so research can't "
        "accidentally mutate state.",
        "anthropic",                    # deep reasoning default
    ),
    (
        "summarizer",
        "Cheap summarisation worker. Suited for stage 19 / context "
        "compaction overflow.",
        "openai",                       # cheap model
    ),
    (
        "critic",
        "Code-aware review using the local Claude Code CLI.",
        "claude_code_cli",
    ),
    (
        "vtuber-narrator",
        "VTuber persona for short stream narrations. Memory + "
        "Knowledge tools only.",
        None,
    ),
)


def _placeholder_factory():
    """Stub factory for descriptors that don't need a real sub-pipeline
    (viewer-only). The executor's Stage 12 only invokes the factory
    when the LLM actually delegates to that agent_type — registering
    the descriptor is enough to surface the name in the registry/UI.
    """
    raise NotImplementedError(
        "Subagent factory not wired — Geny does not currently spawn "
        "sub-pipelines from this descriptor.",
    )


def _make_descriptors() -> List[Any]:
    """Build the descriptor list lazily so test environments without
    geny-executor installed still import this module.

    Tolerates executor signature drift: each constructor is tried with
    the canonical kwargs first, falls back to the legacy
    no-factory shape, and swallows any remaining TypeError so a single
    bad seed can't crash module import (which cascades into a 500 on
    boot for every controller that imports this package)."""
    if SubagentTypeDescriptor is None:
        return []

    out: List[Any] = []
    for agent_type, description, provider in _SEED:
        # Phase E1 — try the v2.0.0 signature with provider/parallel
        # fields first; fall back to the v1 signature if the installed
        # executor predates Phase D1 (unlikely once Geny pins >=2.0.0).
        try:
            out.append(SubagentTypeDescriptor(
                agent_type=agent_type,
                factory=_placeholder_factory,
                description=description,
                provider=provider,
            ))
            continue
        except TypeError:
            pass
        try:
            out.append(SubagentTypeDescriptor(
                agent_type=agent_type,
                factory=_placeholder_factory,
                description=description,
            ))
            continue
        except TypeError:
            pass
        try:
            out.append(SubagentTypeDescriptor(
                agent_type=agent_type,
                description=description,
            ))
        except TypeError as exc:
            logger.warning(
                "subagent_descriptor_build_failed agent_type=%s err=%s",
                agent_type, exc,
            )
    return out


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
