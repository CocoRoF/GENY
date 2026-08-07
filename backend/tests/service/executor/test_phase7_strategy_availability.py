"""Coverage for G9.x — Phase 7 strategy availability through the manifest.

Each Phase-7 strategy the executor ships (S7.2 through S7.12) is
reachable from the host as a slot impl_name. This file asserts:

1. The slot's registry exposes the impl_name (tests that the
   executor pin still has the strategy class registered — fails
   loud if a future executor minor version moves it out).

2. worker_adaptive's manifest entry actually selects the strategy
   we've opted in (G9.9 ThinkingBudgetPlanner is the only flip on
   this PR; the rest stay on safe defaults pending per-preset
   config tuning — those tests assert "available but not active").

The point is to lock the *availability* contract in tests so a
follow-on PR that flips a preset to a Phase-7 strategy doesn't
silently break when the executor's slot map changes.
"""

from __future__ import annotations

import pytest

pytest.importorskip("geny_executor")

from geny_executor.core.pipeline import Pipeline  # noqa: E402

from geny_executor import build_manifest  # noqa: E402


# ── Strategy availability matrix ───────────────────────────────────


_AVAILABILITY = [
    # (stage_order, slot_name, impl_name, sprint_id)
    (2, "retriever", "mcp_resource", "G9.1"),  # registered by service.strategies
    (6, "router", "adaptive", "G9.7"),
    (8, "budget_planner", "adaptive", "G9.9"),
    (9, "parser", "structured_output", "G9.2"),
    (12, "orchestrator", "subagent_type", "G9.4"),
    (14, "strategy", "evaluation_chain", "G9.5"),
    (16, "controller", "multi_dim_budget", "G9.6"),
    (18, "strategy", "structured_reflective", "G9.8"),
    (21, "formatter", "multi_format", "G9.11"),
]


@pytest.mark.parametrize("order,slot_name,impl_name,sprint", _AVAILABILITY)
def test_phase7_strategy_registered_in_slot(
    order: int, slot_name: str, impl_name: str, sprint: str
) -> None:
    """Every Phase-7 strategy this cycle adopted must be reachable
    by ``impl_name`` on the named slot. Fails loud if a future
    executor pin renames or unregisters the strategy."""
    manifest = build_manifest("worker_adaptive", model="claude-haiku-4-5-20251001", provider="anthropic")
    pipeline = Pipeline.from_manifest(manifest, api_key="sk-test", strict=False)

    # G9.1 (mcp_resource) is registered by the agent_session install
    # path, not by the executor's stage __init__. Run that install
    # here so the test mirrors the production session-build flow.
    if (order, slot_name, impl_name) == (2, "retriever", "mcp_resource"):
        from service.strategies import register_mcp_resource_retriever
        register_mcp_resource_retriever(pipeline)

    stage = next((s for s in pipeline.stages if s.order == order), None)
    assert stage is not None, f"{sprint}: pipeline missing Stage {order}"

    slots = stage.get_strategy_slots()
    slot = slots.get(slot_name)
    assert slot is not None, (
        f"{sprint}: Stage {order} has no '{slot_name}' slot. "
        f"Available slots: {list(slots)}"
    )

    registry = getattr(slot, "_registry", None) or getattr(slot, "registry", None)
    assert isinstance(registry, dict)
    assert impl_name in registry, (
        f"{sprint}: strategy '{impl_name}' missing from Stage {order}'s "
        f"'{slot_name}' slot registry. Have: {sorted(registry)}"
    )


# ── Active strategy assertions (sprints that flipped a preset) ─────


def test_g9_9_worker_adaptive_uses_adaptive_thinking_budget() -> None:
    """G9.9: worker_adaptive opts s08's budget_planner in to
    ``adaptive`` so chatty turns get a budget step-down without
    losing first-turn deep planning."""
    manifest = build_manifest("worker_adaptive", provider="anthropic")
    think = next(e for e in manifest.stages if e["order"] == 8)
    assert think["strategies"]["budget_planner"] == "adaptive"


def test_g9_9_vtuber_think_stage_uses_the_adaptive_budget_planner() -> None:
    """VTuber declares Stage 8 with an ADAPTIVE budget planner.

    This asserted the opposite — that vtuber omits Stage 8, or at most keeps
    a static planner — from when think was dropped for the VTuber preset.
    The stage is back, and adaptive.
    """
    manifest = build_manifest("vtuber", provider="anthropic")
    stage8 = [e for e in manifest.stages if e["order"] == 8]

    assert len(stage8) == 1, "vtuber no longer declares a think stage"
    assert stage8[0]["name"] == "think"
    assert stage8[0]["strategies"]["budget_planner"] == "adaptive"
