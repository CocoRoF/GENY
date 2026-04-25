"""Audit gap (post_cycle_audit §3): service/strategies/__init__.py
had only indirect coverage via test_phase7_strategy_availability.py.
This file exercises the registration helper directly so a future
refactor that breaks the no-op / idempotency / slot-write contract
fails loud here instead of silently masking a regression in the
preset-availability matrix.

Skipped when geny_executor isn't importable.
"""

from __future__ import annotations

import pytest

pytest.importorskip("geny_executor")

from geny_executor.core.pipeline import Pipeline  # noqa: E402

from service.executor.default_manifest import build_default_manifest  # noqa: E402
from service.strategies import register_mcp_resource_retriever  # noqa: E402


# ── No-op safety ────────────────────────────────────────────────────


def test_register_returns_false_for_none_pipeline() -> None:
    """A None pipeline (e.g. session never built one) must short-circuit
    rather than crash. Returns False to signal nothing was wired."""
    assert register_mcp_resource_retriever(None) is False


class _NoStagePipeline:
    """Pipeline-like object with neither get_stage nor _stages."""

    pass


def test_register_returns_false_when_no_stage_lookup() -> None:
    assert register_mcp_resource_retriever(_NoStagePipeline()) is False


class _PipelineWithoutStage2:
    """get_stage callable but returns None for order=2."""

    def get_stage(self, order: int):
        return None


def test_register_returns_false_when_stage_2_missing() -> None:
    assert register_mcp_resource_retriever(_PipelineWithoutStage2()) is False


# ── Real Stage 2 → registry mutation ────────────────────────────────


def _build_real_pipeline():
    """Build a real Pipeline.from_manifest using worker_adaptive so
    Stage 2 is present with its actual slot registry."""
    manifest = build_default_manifest("worker_adaptive", model="claude-haiku-4-5-20251001")
    return Pipeline.from_manifest(manifest, api_key="sk-test", strict=False)


def test_register_adds_mcp_resource_to_slot_registry() -> None:
    pipeline = _build_real_pipeline()
    stage = next(s for s in pipeline.stages if s.order == 2)
    slot = stage.get_strategy_slots()["retriever"]
    registry = getattr(slot, "_registry", None) or getattr(slot, "registry", None)
    assert isinstance(registry, dict)
    # Pre-condition: default slot ships with null + static, no mcp_resource.
    assert "mcp_resource" not in registry

    added = register_mcp_resource_retriever(pipeline)
    assert added is True
    assert "mcp_resource" in registry


def test_register_is_idempotent() -> None:
    pipeline = _build_real_pipeline()
    first = register_mcp_resource_retriever(pipeline)
    second = register_mcp_resource_retriever(pipeline)
    assert first is True
    # Second call returns True (already present is success, not no-op
    # failure) — the registry didn't double-register.
    assert second is True

    stage = next(s for s in pipeline.stages if s.order == 2)
    slot = stage.get_strategy_slots()["retriever"]
    registry = getattr(slot, "_registry", None) or getattr(slot, "registry", None)
    # Class object is the same on both calls — registry would have a
    # single entry under the name regardless of dict.update repeat.
    assert "mcp_resource" in registry


def test_register_does_not_change_active_strategy() -> None:
    """Registration adds the impl to the slot's name → class map but
    must NOT swap the active retriever. attach_runtime owns active
    retriever selection — register_mcp_resource_retriever is a
    "you can pick this in the manifest now" signal only."""
    pipeline = _build_real_pipeline()
    stage = next(s for s in pipeline.stages if s.order == 2)
    slot = stage.get_strategy_slots()["retriever"]
    before_active = type(slot.strategy).__name__

    register_mcp_resource_retriever(pipeline)

    after_active = type(slot.strategy).__name__
    assert before_active == after_active
