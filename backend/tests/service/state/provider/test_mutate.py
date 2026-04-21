"""``apply_mutations`` contract (cycle 20260421_9 PR-X3-2).

These tests verify the pure mutation-replay core used by both providers:
each op × each representative path, ring-buffer trimming, error paths.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.service.state.provider.mutate import apply_mutations
from backend.service.state.provider.interface import RECENT_EVENTS_MAX
from backend.service.state.schema.creature_state import CreatureState
from backend.service.state.schema.mutation import Mutation


def _mk_state(**overrides) -> CreatureState:
    return CreatureState(
        character_id="c1",
        owner_user_id="u1",
        **overrides,
    )


def _mut(op: str, path: str, value, source: str = "test") -> Mutation:
    return Mutation(op=op, path=path, value=value, source=source)  # type: ignore[arg-type]


def test_empty_mutations_returns_same_instance() -> None:
    s = _mk_state()
    out = apply_mutations(s, [])
    assert out is s


def test_add_adjusts_numeric_vital() -> None:
    s = _mk_state()
    out = apply_mutations(s, [_mut("add", "vitals.hunger", -20.0)])
    assert out.vitals.hunger == pytest.approx(30.0)
    # original untouched
    assert s.vitals.hunger == pytest.approx(50.0)


def test_add_on_bond_path() -> None:
    s = _mk_state()
    out = apply_mutations(s, [_mut("add", "bond.affection", +1.5)])
    assert out.bond.affection == pytest.approx(1.5)


def test_add_on_nonnumeric_raises() -> None:
    s = _mk_state()
    with pytest.raises(TypeError):
        apply_mutations(s, [_mut("add", "progression.life_stage", 1.0)])


def test_add_with_nonnumeric_delta_raises() -> None:
    s = _mk_state()
    with pytest.raises(TypeError):
        apply_mutations(s, [_mut("add", "vitals.hunger", "oops")])


def test_set_replaces_any_path() -> None:
    s = _mk_state()
    out = apply_mutations(
        s, [_mut("set", "progression.life_stage", "teen", source="admin")]
    )
    assert out.progression.life_stage == "teen"


def test_append_pushes_onto_recent_events() -> None:
    s = _mk_state()
    out = apply_mutations(s, [_mut("append", "recent_events", "fed")])
    assert out.recent_events == ["fed"]


def test_append_on_milestones() -> None:
    s = _mk_state()
    out = apply_mutations(
        s, [_mut("append", "progression.milestones", "first_meet")]
    )
    assert out.progression.milestones == ["first_meet"]


def test_append_on_nonlist_raises() -> None:
    s = _mk_state()
    with pytest.raises(TypeError):
        apply_mutations(s, [_mut("append", "vitals.hunger", 1.0)])


def test_event_pushes_tag_on_recent_events() -> None:
    s = _mk_state()
    out = apply_mutations(s, [_mut("event", "", "first_meet")])
    assert out.recent_events == ["first_meet"]


def test_recent_events_trims_to_ring_buffer() -> None:
    s = _mk_state()
    muts = [_mut("append", "recent_events", f"e{i}") for i in range(RECENT_EVENTS_MAX + 5)]
    out = apply_mutations(s, muts)
    assert len(out.recent_events) == RECENT_EVENTS_MAX
    # Oldest 5 dropped; newest kept.
    assert out.recent_events[0] == "e5"
    assert out.recent_events[-1] == f"e{RECENT_EVENTS_MAX + 4}"


def test_ordering_dependent_add_then_set() -> None:
    s = _mk_state()
    out = apply_mutations(
        s,
        [
            _mut("add", "vitals.hunger", +2.0),
            _mut("set", "vitals.hunger", 10.0),
        ],
    )
    # set wins because it came after add.
    assert out.vitals.hunger == pytest.approx(10.0)


def test_ordering_dependent_set_then_add() -> None:
    s = _mk_state()
    out = apply_mutations(
        s,
        [
            _mut("set", "vitals.hunger", 10.0),
            _mut("add", "vitals.hunger", +2.0),
        ],
    )
    assert out.vitals.hunger == pytest.approx(12.0)


def test_unknown_op_raises_value_error() -> None:
    s = _mk_state()
    with pytest.raises(ValueError):
        apply_mutations(s, [_mut("increment", "vitals.hunger", 1.0)])


def test_unknown_path_segment_raises_key_error() -> None:
    s = _mk_state()
    with pytest.raises(KeyError):
        apply_mutations(s, [_mut("add", "vitals.does_not_exist", 1.0)])


def test_partial_failure_leaves_snapshot_untouched() -> None:
    s = _mk_state()
    s.bond.affection = 5.0
    muts = [
        _mut("add", "bond.affection", +2.0),  # would bring to 7.0
        _mut("add", "vitals.unknown", 1.0),    # raises KeyError
    ]
    with pytest.raises(KeyError):
        apply_mutations(s, muts)
    # Original unchanged.
    assert s.bond.affection == pytest.approx(5.0)


def test_last_interaction_at_bumped_when_mutations_applied() -> None:
    s = _mk_state()
    s.last_interaction_at = None
    fixed = datetime(2026, 4, 21, tzinfo=timezone.utc)
    out = apply_mutations(
        s, [_mut("add", "vitals.hunger", -1.0)], now=fixed,
    )
    assert out.last_interaction_at == fixed


def test_last_interaction_at_stable_on_empty_mutations() -> None:
    # fast path returns same instance, doesn't touch last_interaction_at.
    s = _mk_state()
    s.last_interaction_at = datetime(2026, 4, 20, tzinfo=timezone.utc)
    out = apply_mutations(s, [])
    assert out.last_interaction_at == datetime(2026, 4, 20, tzinfo=timezone.utc)
