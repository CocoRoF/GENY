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
    extra_external_tools: tuple[str, ...] = (),
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

    # Advertise the requested tools on BOTH built_in (framework tools like
    # Bash/Read/Write resolved by the executor's BuiltInToolProvider) AND
    # external (Geny custom tools like gapt_* resolved by GenyToolProvider).
    # Each name resolves from whichever provider actually has it; the other
    # provider simply doesn't match it. This is what lets a sub-worker carry
    # CUSTOM tools — previously only built_in was set, so custom tools were
    # silently dropped (no provider matched them).
    _wildcard = allowed_tools == ("*",)
    # extra_external_tools (e.g. connector Computer Use tools) are ALWAYS named
    # in external — even under a wildcard, where `external` is otherwise [] —
    # because they resolve only from an adhoc provider (ConnectorToolProvider),
    # so they must be explicitly listed to activate.
    _extra_ext = list(dict.fromkeys(extra_external_tools or ()))
    _external = (
        list(_extra_ext) if _wildcard
        else list(dict.fromkeys([*allowed_tools, *_extra_ext]))
    )
    m = EnvironmentManifest(
        metadata=EnvironmentMetadata(id="subagent-runtime", name="subagent"),
        model={"model": model} if model else {},
        pipeline={"single_turn": True, "max_iterations": 6},
        stages=[],
        tools=ToolsSnapshot(
            built_in=["*"] if _wildcard else list(allowed_tools),
            external=_external,
        ),
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


def make_subagent_factory(adhoc_providers: Any = (), *, extra_external_tools: Any = (),
                          workspace_ctx: Any = None):
    """Build an async :data:`PipelineFactory` that provisions a sub-worker
    WITH the given adhoc providers passed through to its sub-pipeline.

    Passing the parent session's providers (``GenyToolProvider`` /
    ``ConnectorToolProvider`` / ``SkillToolProvider``) is what lets a
    sub-worker resolve **custom** tools (``gapt_*``, ``web_search``, …) and
    **skills** declared in its ``allowed_tools`` — not just framework
    built-ins. Without them the sub-manifest can name a custom tool but no
    provider matches it, so the sub-worker silently has nothing.

    Provider resolution is delegated to
    :func:`geny_executor.stages.s12_agent.subagent_type.resolve_subagent_provider`
    (descriptor pin → typed ``ctx.parent_provider`` → parent_state_shared →
    bundle preference); a loud :class:`ConfigError` when nothing resolves.
    """
    _providers = tuple(adhoc_providers or ())
    _extra_external_tools = tuple(extra_external_tools or ())
    _workspace_ctx = workspace_ctx

    async def _factory(ctx: Any) -> Any:
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
            extra_external_tools=_extra_external_tools,
        )
        try:
            sub_pipeline = await Pipeline.from_manifest_async(
                sub_manifest,
                credentials=ctx.credentials,
                adhoc_providers=_providers,
                strict=False,
            )
        except Exception:
            logger.exception(
                "subagent factory: failed to build sub-pipeline for %s (provider=%s)",
                desc.agent_type, provider,
            )
            raise

        # ── One-workspace coherence ──────────────────────────────────
        # A sub-agent works in the SAME workspace as its parent: same
        # working_dir (<storage>/workspace), same path guard, and the
        # parent's GAPT sandbox handle so sandboxed tools land in the same
        # container /workspace. Without this the sub-pipeline ran host-side
        # with a default cwd — a separate filesystem from the parent.
        if _workspace_ctx is not None:
            try:
                ws = _workspace_ctx() or {}
                attach: dict = {}
                wd = ws.get("working_dir")
                if wd:
                    from geny_executor.tools.base import ToolContext

                    attach["tool_context"] = ToolContext(
                        session_id=str(ws.get("session_id") or ""),
                        working_dir=str(wd),
                        storage_path=ws.get("storage_path"),
                        allowed_paths=[str(wd)],
                    )
                if ws.get("sandbox") is not None:
                    attach["sandbox"] = ws["sandbox"]
                if attach:
                    sub_pipeline.attach_runtime(**attach)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "subagent factory: workspace attach failed for %s",
                    desc.agent_type, exc_info=True,
                )

        # Per-type system prompt (executor 2.7.1) — when the descriptor
        # declares one (env editor's Sub-Agent panel), override the
        # sub-pipeline's Stage-3 system builder. Best-effort.
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

    return _factory


# Back-compat: a factory with NO adhoc providers (framework built-ins only).
_default_subagent_factory = make_subagent_factory(())


def make_default_subagent_factory():
    """Return the canonical :data:`PipelineFactory` for sub-agents.

    Importable by ``service.agent_types.registry`` to replace the
    placeholder factory in the seed descriptors.
    """
    return _default_subagent_factory
