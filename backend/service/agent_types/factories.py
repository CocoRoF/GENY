"""Real sub-pipeline factories for the Stage 12 sub-agent orchestrator.

Phase E3 of the LLM backend upgrade. Replaces the placeholder factory
in :mod:`service.agent_types.registry` with one that actually spins up
a working sub-pipeline using:

  * The descriptor's ``provider`` (which slots into the sub-manifest's
    Stage 6 ``config['provider']``).
  * The parent's ``CredentialBundle`` (handed in via
    :class:`SubAgentBuildContext.credentials`) so the sub-pipeline
    authenticates against the right backend.
  * A bounded 21-stage manifest derived from Geny's default — the
    sub-agent reuses input/context/system/api/parse/tool/yield/etc.
    but defaults Stage 12 to ``single_agent`` to keep nested sub-agent
    spawn off by default.

The factory is intentionally minimal: it does NOT attach memory,
session-runtime, or MCP. Those are session-scoped concerns the parent
owns; a sub-agent in this cycle is a one-shot reasoning helper, not a
long-running parallel session.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

logger = logging.getLogger(__name__)


__all__ = ["make_default_subagent_factory"]


def _executor_imports():
    """Lazy import so this module loads even if geny-executor is absent
    (defensive — Geny pins >=2.0.0 in pyproject)."""
    from geny_executor import Pipeline
    from geny_executor.core.environment import (
        EnvironmentManifest,
        EnvironmentMetadata,
        StageManifestEntry,
        ToolsSnapshot,
    )

    return Pipeline, EnvironmentManifest, EnvironmentMetadata, StageManifestEntry, ToolsSnapshot


def _build_sub_manifest(
    *,
    provider: str,
    model: Optional[str],
    allowed_tools: tuple[str, ...],
) -> Any:
    """Build a slim 21-stage manifest tuned for a sub-agent.

    Layout mirrors the worker preset's spine (input → api → parse →
    tool → yield) and explicitly omits memory / persist / summarize so
    the sub-agent finishes quickly and doesn't bleed into the parent's
    storage. Stage 12 forces ``single_agent`` to block nested
    delegations.
    """
    (
        Pipeline,
        EnvironmentManifest,
        EnvironmentMetadata,
        StageManifestEntry,
        ToolsSnapshot,
    ) = _executor_imports()

    m = EnvironmentManifest(
        metadata=EnvironmentMetadata(id="subagent-runtime", name="subagent"),
        model={"model": model} if model else {},
        pipeline={"single_turn": True, "max_iterations": 6},
        stages=[],
        tools=ToolsSnapshot(built_in=["*"] if allowed_tools == ("*",) else list(allowed_tools)),
    )
    m.set_stage_entries([
        StageManifestEntry(order=1, name="input"),
        StageManifestEntry(order=3, name="system"),
        StageManifestEntry(order=4, name="guard"),
        StageManifestEntry(
            order=6, name="api",
            config={"provider": provider},
            strategies={"retry": "exponential_backoff", "router": "passthrough"},
        ),
        StageManifestEntry(order=7, name="token"),
        StageManifestEntry(order=9, name="parse"),
        StageManifestEntry(order=10, name="tool"),
        StageManifestEntry(
            order=12, name="agent", active=True,
            # Nested sub-agent dispatch is intentionally disabled.
            strategies={"orchestrator": "single_agent"},
            config={"max_delegations": 0},
        ),
        StageManifestEntry(order=14, name="evaluate"),
        StageManifestEntry(order=16, name="loop"),
        StageManifestEntry(order=21, name="yield"),
    ])
    return m


async def _default_subagent_factory(ctx: Any) -> Any:
    """Async PipelineFactory entrypoint.

    Receives a :class:`SubAgentBuildContext`; returns a built Pipeline.
    The provider comes from ``ctx.descriptor.provider`` (None ⇒ inherit
    parent). Credentials flow straight from ``ctx.credentials``.

    Provider resolution (geny-executor 2.2.0): delegated wholesale to
    :func:`geny_executor.stages.s12_agent.subagent_type.
    resolve_subagent_provider` — THE single library home for the
    resolution order (descriptor pin → typed ``ctx.parent_provider`` →
    legacy ``parent_state_shared['primary_provider']`` → the bundle's
    ``preferred_provider()``). The old hardcoded ``"anthropic"``
    last-resort is gone: when nothing resolves we now raise a loud
    :class:`ConfigError` instead of silently building a sub-agent on a
    backend the user never configured.
    """
    from geny_executor.llm_client.credentials import ConfigError
    from geny_executor.stages.s12_agent.subagent_type import (
        resolve_subagent_provider,
    )

    desc = ctx.descriptor
    provider = resolve_subagent_provider(ctx)
    if not provider:
        raise ConfigError(
            f"subagent {desc.agent_type!r}: no provider could be resolved — "
            "the descriptor declares none, the parent published no "
            "primary_provider, and the credential bundle is empty. "
            "Configure an LLM backend before delegating."
        )

    model_override = desc.model_override or None
    allowed_tools = tuple(desc.allowed_tools or ())

    Pipeline, *_ = _executor_imports()

    sub_manifest = _build_sub_manifest(
        provider=provider,
        model=model_override,
        allowed_tools=allowed_tools,
    )
    try:
        sub_pipeline = await Pipeline.from_manifest_async(
            sub_manifest,
            credentials=ctx.credentials,
            strict=False,
        )
    except Exception:
        logger.exception(
            "subagent factory: failed to build sub-pipeline for %s (provider=%s)",
            desc.agent_type, provider,
        )
        raise

    # Per-companion system prompt (executor 2.7.1) — when the descriptor
    # declares one (set via the env editor's Sub-Agent panel → owned_subagent
    # .system_prompt → SubAgentManager.spawn override), override the
    # sub-pipeline's Stage-3 system builder so the sub-agent runs with that
    # persona. Best-effort: a failure here must not break the build.
    system_prompt = getattr(desc, "system_prompt", None)
    if system_prompt:
        try:
            from geny_executor.stages.s03_system.artifact.default.builders import (
                ComposablePromptBuilder,
                PersonaBlock,
            )

            sub_pipeline.attach_runtime(
                system_builder=ComposablePromptBuilder(
                    blocks=[PersonaBlock(system_prompt)]
                ),
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "subagent factory: system_prompt attach failed for %s",
                desc.agent_type, exc_info=True,
            )
    return sub_pipeline


def make_default_subagent_factory():
    """Return the canonical :data:`PipelineFactory` for sub-agents.

    Importable by ``service.agent_types.registry`` to replace the
    placeholder factory in the seed descriptors.
    """
    return _default_subagent_factory
