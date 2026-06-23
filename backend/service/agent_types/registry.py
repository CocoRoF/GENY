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

# The GENERALIZED, app-neutral catalog now lives in geny-executor (>=2.8.0):
# worker / researcher / summarizer / critic, each with a strong default
# system prompt + tool shape. Geny consumes it and lets users override / extend
# / subset per-env (see SubagentRegistryBuilder + the env editor's Sub-Worker
# panel). App-specific types (e.g. a vtuber narrator) are NOT seeded here — add
# them per-env when wanted.
try:  # pragma: no cover — covered by e2e environment
    from geny_executor.stages.s12_agent.subagent_catalog import (
        default_subagent_specs as _exec_default_specs,
        specs_to_descriptors as _exec_specs_to_descriptors,
    )
except ImportError:  # pragma: no cover — executor < 2.8.0
    _exec_default_specs = None  # type: ignore[assignment]
    _exec_specs_to_descriptors = None  # type: ignore[assignment]


# Fallback seed used ONLY when geny-executor (<2.8.0) doesn't expose the
# generalized catalog. The real catalog lives in the library now (worker /
# researcher / summarizer / critic with strong default prompts). ``None``
# provider = inherit the parent's Stage-6 provider.
_FALLBACK_SEED = (
    ("worker", "General-purpose autonomous worker. Full default toolset.", None),
    (
        "researcher",
        "Read-only investigation (Read / Grep / Glob / WebFetch / WebSearch).",
        None,
    ),
    ("summarizer", "Faithful, compact summarization of supplied material.", None),
    ("critic", "Rigorous read-only review — surfaces substantiated defects.", None),
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
    """Build the seed descriptor list lazily.

    Primary path (geny-executor >=2.8.0): wire the library's GENERALIZED
    catalog (``default_subagent_specs``) with Geny's real default factory via
    ``specs_to_descriptors`` — so the generalized types + their strong default
    prompts live in one place (the library) and Geny just attaches its
    factory. Falls back to a minimal local seed for older executors, and
    returns ``[]`` when geny-executor isn't importable at all (test env)."""
    if SubagentTypeDescriptor is None:
        return []

    factory = _resolve_default_factory()

    # Generalized catalog from the library (preferred).
    if _exec_specs_to_descriptors is not None and _exec_default_specs is not None:
        try:
            descs = _exec_specs_to_descriptors(factory, _exec_default_specs())
            if descs:
                return list(descs)
        except Exception as exc:  # noqa: BLE001 — fall back below
            logger.warning("generalized catalog wiring failed: %s", exc)

    # Fallback for executor < 2.8.0 (no catalog module).
    out: List[Any] = []
    for agent_type, description, provider in _FALLBACK_SEED:
        try:
            out.append(SubagentTypeDescriptor(
                agent_type=agent_type, factory=factory,
                description=description, provider=provider,
            ))
        except TypeError:
            try:
                out.append(SubagentTypeDescriptor(
                    agent_type=agent_type, factory=factory, description=description,
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


def build_descriptor_from_config(cfg: Any, *, factory: Any = None) -> Optional[Any]:
    """Build one :class:`SubagentTypeDescriptor` from a plain config dict.

    Used for the per-env precise Sub-Worker roster
    (``host_selections.extras.subworker_types``). Carries the editable fields
    (description / provider / model / system_prompt / allowed_tools) onto the
    descriptor; the factory honours them when it builds the one-shot sub-worker
    pipeline. Returns None for an empty / unbuildable entry.

    ``factory`` overrides the default sub-agent factory — the session manager
    passes a provider-aware factory (built via
    ``factories.make_subagent_factory(adhoc_providers)``) so the sub-worker can
    resolve CUSTOM tools (gapt_*, web_search, …) + skills, not just framework
    built-ins.
    """
    if SubagentTypeDescriptor is None or not isinstance(cfg, dict):
        return None
    agent_type = str(cfg.get("agent_type") or "").strip()
    if not agent_type:
        return None

    kwargs: dict[str, Any] = {
        "agent_type": agent_type,
        "factory": factory or _resolve_default_factory(),
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
