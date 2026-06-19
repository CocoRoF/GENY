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


# Seed sub-agent descriptors. ``provider=None`` means "inherit parent's
# Stage-6 provider" (resolved by ``_default_subagent_factory``); any
# non-None value pins a specific backend because the agent's tool
# requirements demand it (e.g. ``critic`` is fundamentally a
# Claude-Code-CLI agent).
#
# The previous values (``researcher → "anthropic"``,
# ``summarizer → "openai"``) were hardcoded preferences for "deep
# reasoning" vs "cheap model". They broke users who never configured
# those backends — a user logged into Claude Code with no Anthropic
# key would still see the researcher try to call Anthropic and 401.
# The choice of "which model is cheap / which is deep" belongs in
# ``model_override`` (or a future routing layer), not in a hardcoded
# vendor pin that ignores what the user actually has access to.
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
        None,                           # inherit parent provider
    ),
    (
        "summarizer",
        "Cheap summarisation worker. Suited for stage 19 / context "
        "compaction overflow.",
        None,                           # inherit parent provider
    ),
    (
        "critic",
        "Code-aware review using the local Claude Code CLI.",
        "claude_code_cli",              # genuinely CLI-specific
    ),
    (
        "vtuber-narrator",
        "VTuber persona for short stream narrations. Memory + "
        "Knowledge tools only.",
        None,
    ),
)


def _placeholder_factory():
    """Legacy zero-arg placeholder. Retained as the absolute fallback
    when ``service.agent_types.factories`` cannot be imported (e.g.
    when geny-executor is absent during a minimal test environment).
    Production sub-agents run through the real factory below."""
    raise NotImplementedError(
        "This descriptor was built without a real factory. Pin "
        "geny-executor>=2.0.0 so service.agent_types.factories is "
        "importable, then re-create the registry.",
    )


def _resolve_default_factory():
    """Lazy import of the v2.0.0 sub-pipeline factory.

    Phase E3 wires this in. Any failure (missing executor, etc) falls
    back to ``_placeholder_factory`` so module load never crashes — the
    failure surfaces only when the LLM actually tries to delegate.
    """
    try:
        from service.agent_types.factories import make_default_subagent_factory

        return make_default_subagent_factory()
    except Exception:  # noqa: BLE001 — defensive
        logger.warning("subagent factory import failed; using placeholder")
        return _placeholder_factory


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

    factory = _resolve_default_factory()
    out: List[Any] = []
    for agent_type, description, provider in _SEED:
        # Phase E3 — descriptors now ship with the real default
        # factory. The fallback branches stay so an older executor
        # still loads.
        try:
            out.append(SubagentTypeDescriptor(
                agent_type=agent_type,
                factory=factory,
                description=description,
                provider=provider,
            ))
            continue
        except TypeError:
            pass
        try:
            out.append(SubagentTypeDescriptor(
                agent_type=agent_type,
                factory=factory,
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


#: Keys the env editor's per-env Sub-Worker roster may carry. ``model`` maps to
#: the descriptor's ``model_override``; the rest are 1:1.
SUBWORKER_CONFIG_KEYS = (
    "agent_type",
    "enabled",
    "description",
    "provider",
    "model",
    "system_prompt",
    "allowed_tools",
)


def build_descriptor_from_config(cfg: Any) -> Optional[Any]:
    """Build one :class:`SubagentTypeDescriptor` from a plain config dict.

    Used for the per-env precise Sub-Worker roster
    (``host_selections.extras.subworker_types``). Carries the editable fields
    (description / provider / model / system_prompt / allowed_tools) onto the
    descriptor; the default factory honours them when it builds the one-shot
    sub-worker pipeline. Returns None for an empty / unbuildable entry.
    """
    if SubagentTypeDescriptor is None or not isinstance(cfg, dict):
        return None
    agent_type = str(cfg.get("agent_type") or "").strip()
    if not agent_type:
        return None

    kwargs: dict[str, Any] = {
        "agent_type": agent_type,
        "factory": _resolve_default_factory(),
    }
    if cfg.get("description"):
        kwargs["description"] = str(cfg["description"])
    if cfg.get("provider"):
        kwargs["provider"] = str(cfg["provider"])
    if cfg.get("model"):
        kwargs["model_override"] = str(cfg["model"])
    if cfg.get("system_prompt"):
        kwargs["system_prompt"] = str(cfg["system_prompt"])
    tools = cfg.get("allowed_tools")
    if isinstance(tools, (list, tuple)) and tools:
        kwargs["allowed_tools"] = tuple(str(t) for t in tools)

    try:
        return SubagentTypeDescriptor(**kwargs)
    except TypeError:
        # Older executor: drop fields it doesn't accept, keep the essentials.
        for k in ("system_prompt",):
            kwargs.pop(k, None)
        try:
            return SubagentTypeDescriptor(**kwargs)
        except TypeError as exc:
            logger.warning(
                "build_descriptor_from_config failed agent_type=%s err=%s",
                agent_type, exc,
            )
            return None


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
