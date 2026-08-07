"""Unit tests for the library manifest factory (:func:`geny_executor.build_manifest`).

geny-executor 2.2.0 absorbed Geny's ``service.executor.default_manifest``
builder; these tests now pin the library factory output from the Geny
side (the same invariants the deleted builder guaranteed).

Regression protection for PR #1 of the 20260420_4 cycle
(`fix/manifest-tool-stages`). If a future change drops stages
10/12/17 from the builder — intentionally or accidentally — the
system would silently regress to the pre-fix "tool calls never
run" state because :meth:`Pipeline._try_run_stage` bypasses
missing stages with only a ``stage.bypass`` event. These tests
make that regression loud.

geny-executor 1.0+ moved agent 11→12 and emit 14→17 as part of
the 21-stage layout (Sub-phase 9a). The asserts below track
the new orders.
"""

from __future__ import annotations

import pytest


def _known_preset_ids():
    return ("worker_adaptive", "vtuber")


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_manifest_declares_tool_stage(preset: str) -> None:
    from geny_executor import build_manifest

    manifest = build_manifest(preset, provider="anthropic")
    orders = {entry["order"] for entry in manifest.stages}

    # 21-stage layout: tool=10, agent=12 (was 11), emit=17 (was 14).
    assert 10 in orders, f"{preset} manifest missing Stage 10 (tool)"
    assert 12 in orders, f"{preset} manifest missing Stage 12 (agent)"
    assert 17 in orders, f"{preset} manifest missing Stage 17 (emit)"


# Per-preset opt-in for the 5 scaffold stages. Updated as each
# G2.x sprint promotes a scaffold from "advisory" to "wired".
#   G2.2 — summarize     (19) on worker_adaptive + vtuber
#   G2.3 — persist       (20) on worker_adaptive + vtuber (FilePersister swapped at runtime)
#   G2.4 — tool_review   (11) on worker_adaptive (full chain) + vtuber (schema + sensitive only)
#   G2.5 — hitl          (15) on worker_adaptive (PipelineResumeRequester swapped at runtime)
#   G2.6 — task_registry (13) on worker_adaptive (in_memory + fire_and_forget)
_ACTIVE_SCAFFOLDS_BY_PRESET: dict[str, set[int]] = {
    "worker_adaptive": {11, 13, 15, 19, 20},
    "vtuber": {11, 19, 20},
}


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_manifest_declares_21_stage_layout(preset: str) -> None:
    """Sub-phase 9a (executor 1.0+) widened the layout to 21 slots.

    Every preset emits all 21 entries — vtuber's Stage 8 (think) ships
    active=False rather than being omitted, so the canvas's order-8
    node behaves like every other inactive stage instead of a
    "missing" slot. Scaffold opt-in tracked in
    :data:`_ACTIVE_SCAFFOLDS_BY_PRESET` — each G2.x sprint flips one
    or more scaffold stages from default inactive to active.
    """
    from geny_executor import build_manifest

    manifest = build_manifest(preset, provider="anthropic")
    orders = {entry["order"] for entry in manifest.stages}

    expected = set(range(1, 22))
    assert orders == expected, (
        f"{preset}: orders={sorted(orders)} expected={sorted(expected)}"
    )

    by_order = {e["order"]: e for e in manifest.stages}
    expected_active = _ACTIVE_SCAFFOLDS_BY_PRESET.get(preset, set())
    for scaffold_order in (11, 13, 15, 19, 20):
        expected_state = scaffold_order in expected_active
        assert by_order[scaffold_order]["active"] is expected_state, (
            f"{preset}: scaffold order {scaffold_order} active state mismatch "
            f"(expected={expected_state}, got={by_order[scaffold_order]['active']})"
        )


def test_summarize_uses_real_strategies_on_both_presets() -> None:
    """G2.2: worker_adaptive and vtuber both opt the Stage 19 Summarize
    scaffold in with the real RuleBasedSummarizer + HeuristicImportance
    picks. The structured turn record they publish to
    state.shared['turn_summary'] feeds the GenyMemoryStrategy that
    attach_runtime installs."""
    from geny_executor import build_manifest

    for preset in ("worker_adaptive", "vtuber"):
        m = build_manifest(preset, provider="anthropic")
        summarize = next(e for e in m.stages if e["order"] == 19)
        assert summarize["active"] is True, f"{preset}: summarize must be active"
        assert summarize["strategies"]["summarizer"] == "rule_based"
        assert summarize["strategies"]["importance"] == "heuristic"


def test_worker_adaptive_activates_full_tool_review_chain() -> None:
    """G2.4: worker_adaptive opts the Stage 11 Tool Review scaffold
    in with the full chain default (schema → sensitive → destructive
    → network → size); flag events are forwarded to the session_logger
    by the agent_session event loop."""
    from geny_executor import build_manifest

    m = build_manifest("worker_adaptive", provider="anthropic")
    review = next(e for e in m.stages if e["order"] == 11)
    assert review["active"] is True
    assert review["chain_order"]["reviewers"] == [
        "schema",
        "sensitive",
        "destructive",
        "network",
        "size",
    ]


def test_vtuber_activates_lightweight_tool_review_chain() -> None:
    """G2.4 (vtuber variant): vtuber opts Stage 11 in with a trimmed
    reviewer chain. The conversational tool surface is small, so only
    schema (arg validation) + sensitive (PII / secret leak) reviewers
    are kept. destructive / network / size add cost without value
    on a web_search / news_search / web_fetch surface."""
    from geny_executor import build_manifest

    m = build_manifest("vtuber", provider="anthropic")
    review = next(e for e in m.stages if e["order"] == 11)
    assert review["active"] is True
    assert review["chain_order"]["reviewers"] == ["schema", "sensitive"]


def test_worker_adaptive_activates_hitl_with_null_requester_placeholder() -> None:
    """G2.5: worker_adaptive opts the Stage 15 HITL gate in. The
    requester slot stays at ``null`` in the manifest — the real
    PipelineResumeRequester is wired by
    ``service.hitl.install_pipeline_resume_requester`` at session
    build time because it needs a Pipeline reference. Active
    state with the always-approve null requester is a free no-op
    until something writes to ``state.shared['hitl_request']``."""
    from geny_executor import build_manifest

    m = build_manifest("worker_adaptive", provider="anthropic")
    hitl = next(e for e in m.stages if e["order"] == 15)
    assert hitl["active"] is True
    assert hitl["strategies"]["requester"] == "null"
    assert hitl["strategies"]["timeout"] == "indefinite"

    # vtuber keeps hitl off — VTuber sessions have no approval surface.
    s = next(e for e in build_manifest("vtuber", provider="anthropic").stages if e["order"] == 15)
    assert s["active"] is False


def test_worker_adaptive_activates_task_registry() -> None:
    """G2.6: worker_adaptive opts the Stage 13 Task Registry scaffold
    in with the in_memory registry + fire_and_forget policy. Sub-worker
    delegations (send_direct_message_internal, spawn_subworker) get a
    per-pipeline lifecycle handle alongside the host-scoped TaskRegistry
    that ``main.py`` configures at ``app.state.task_registry`` for cron
    and /tasks endpoints. vtuber stays off — single-agent persona has
    no delegation surface."""
    from geny_executor import build_manifest

    m = build_manifest("worker_adaptive", provider="anthropic")
    registry = next(e for e in m.stages if e["order"] == 13)
    assert registry["active"] is True
    assert registry["strategies"]["registry"] == "in_memory"
    assert registry["strategies"]["policy"] == "fire_and_forget"

    # vtuber keeps task_registry off — no delegation surface.
    s = next(e for e in build_manifest("vtuber", provider="anthropic").stages if e["order"] == 13)
    assert s["active"] is False


def test_persist_active_on_both_presets_with_on_significant_frequency() -> None:
    """G2.3: worker_adaptive and vtuber both opt Stage 20 Persist in
    with the on_significant frequency. The persister slot stays at
    no_persist in the manifest — the real FilePersister is wired by
    ``service.persist.install_file_persister`` at session-build time
    once the storage_path is known. The helper is preset-agnostic
    so the same wiring applies to vtuber sessions."""
    from geny_executor import build_manifest

    for preset in ("worker_adaptive", "vtuber"):
        m = build_manifest(preset, provider="anthropic")
        persist = next(e for e in m.stages if e["order"] == 20)
        assert persist["active"] is True, f"{preset}: persist must be active"
        # Real persister is runtime-wired; manifest carries the placeholder.
        assert persist["strategies"]["persister"] == "no_persist"
        assert persist["strategies"]["frequency"] == "on_significant"


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_tool_stage_has_default_strategies(preset: str) -> None:
    """G6.2: worker_adaptive flips to capability-aware ``partition``
    execution; vtuber stays sequential because it doesn't run
    general-purpose tools."""
    from geny_executor import build_manifest

    manifest = build_manifest(preset, provider="anthropic")
    entry = next(e for e in manifest.stages if e["order"] == 10)

    assert entry["name"] == "tool"
    if preset == "vtuber":
        assert entry["strategies"] == {"executor": "sequential", "router": "registry"}
    else:
        assert entry["strategies"] == {"executor": "partition", "router": "registry"}
        assert entry["config"] == {"max_concurrency": 8}


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_agent_stage_orchestrator_is_subagent_type(preset: str) -> None:
    """Agent moved 11 → 12 in the 21-stage layout, and its orchestrator moved
    from ``single_agent`` to ``subagent_type`` when delegation landed."""
    from geny_executor import build_manifest

    manifest = build_manifest(preset, provider="anthropic")
    entry = next(e for e in manifest.stages if e["order"] == 12)

    assert entry["name"] == "agent"
    assert entry["strategies"] == {"orchestrator": "subagent_type"}
    assert entry["config"] == {"max_delegations": 4}


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_emit_stage_uses_empty_chain(preset: str) -> None:
    """Emit moved 14 → 17 in the 21-stage layout."""
    from geny_executor import build_manifest

    manifest = build_manifest(preset, provider="anthropic")
    entry = next(e for e in manifest.stages if e["order"] == 17)

    assert entry["name"] == "emit"
    assert entry["chain_order"] == {"emitters": []}


def test_vtuber_manifest_declares_think_inactive() -> None:
    """VTuber declares Stage 8 (think) but ships it inactive.

    Previously the entry was omitted entirely so the canvas's order-8
    node was a "missing" slot — clicking it produced a stage-not-found
    error rather than the standard inactive editor. The entry now lives
    in the manifest with ``active=False`` so the slot behaves like
    every other inactive stage and a host can opt the persona into
    Extended Thinking by flipping the flag."""
    from geny_executor import build_manifest

    think = next(
        (e for e in build_manifest("vtuber", provider="anthropic").stages if e["order"] == 8),
        None,
    )
    assert think is not None, "VTuber must declare Stage 8 (think) entry"
    assert think["name"] == "think"
    assert think["active"] is False, (
        "VTuber's Stage 8 must default inactive — flip is opt-in"
    )


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_manifest_built_in_is_empty(preset: str) -> None:
    """`manifest.tools.built_in` is dead metadata — the executor's
    `_register_external_tools` only walks `.external`. The factory
    should leave `.built_in` empty to keep the manifest honest
    about what actually reaches the registry. Regression guard
    against re-introducing a hardcoded builtin list (e.g. the old
    ``["Read", "Write", "Edit", ...]`` that pointed at names no
    provider supplied)."""
    from geny_executor import build_manifest

    manifest = build_manifest(preset, provider="anthropic")
    assert list(manifest.tools.built_in) == [], (
        f"{preset}: manifest.tools.built_in must be empty — the "
        f"executor does not consume it; populating it creates dead "
        f"metadata. Got: {list(manifest.tools.built_in)}"
    )


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_manifest_external_is_caller_supplied(preset: str) -> None:
    """Everything the caller passes as ``external_tool_names`` lands
    verbatim in ``manifest.tools.external`` — this is the single
    registration path the executor honours."""
    from geny_executor import build_manifest

    names = ["send_direct_message_external", "memory_read", "web_search"]
    manifest = build_manifest(preset, provider="anthropic", external_tools=names)
    assert list(manifest.tools.external) == names


@pytest.mark.parametrize("preset", _known_preset_ids())
def test_pipeline_from_manifest_registers_tool_stages(preset: str) -> None:
    """End-to-end wiring check: the stage entries the builder emits
    actually produce registered Stage objects in a materialized
    Pipeline. Catches regressions where a stage name or artifact
    pair no longer resolves through ``create_stage``."""
    from geny_executor.core.pipeline import Pipeline

    from geny_executor import build_manifest

    manifest = build_manifest(preset, provider="anthropic", model="claude-haiku-4-5-20251001")
    pipeline = Pipeline.from_manifest(manifest, api_key="sk-test", strict=False)

    registered_orders = {s.order for s in pipeline.stages}
    # 21-stage layout: tool=10, agent=12, emit=17.
    assert {10, 12, 17}.issubset(registered_orders), (
        f"{preset}: pipeline stages = {sorted(registered_orders)}"
    )
