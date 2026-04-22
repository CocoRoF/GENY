"""Mutation / MutationBuffer contract (cycle 20260421_9 PR-X3-1).

These tests pin down the append protocol, ordering, immutability of the
``items`` snapshot, and ``len / bool / iter`` behavior that stages rely on.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from service.state.schema.mutation import (
    Mutation,
    MutationBuffer,
    MutationOp,
)


def test_mutation_is_frozen() -> None:
    m = Mutation(op="add", path="vitals.hunger", value=3.0, source="test")
    with pytest.raises(Exception):  # FrozenInstanceError subclasses AttributeError
        m.op = "set"  # type: ignore[misc]


def test_mutation_has_default_timestamp() -> None:
    before = datetime.now(timezone.utc)
    m = Mutation(op="event", path="", value="hello", source="t")
    after = datetime.now(timezone.utc)
    assert m.at.tzinfo is not None
    assert before <= m.at <= after


def test_mutation_op_literal_runtime_accepts_known() -> None:
    # Literal is compile-time only; runtime just uses the string. These are
    # the four supported ops — everything else is anti-contract.
    for op in ("add", "set", "append", "event"):
        m = Mutation(op=op, path="x", value=1, source="t")  # type: ignore[arg-type]
        assert m.op == op


def test_buffer_empty_defaults() -> None:
    b = MutationBuffer()
    assert len(b) == 0
    assert bool(b) is False
    assert b.items == ()
    assert list(iter(b)) == []


def test_buffer_append_grows_in_order() -> None:
    b = MutationBuffer()
    b.append(op="add", path="vitals.hunger", value=-20.0, source="s10/feed")
    b.append(op="append", path="recent_events", value="fed", source="s10/feed")
    b.append(op="event", path="", value="first_meet", source="s12/evaluate")

    assert len(b) == 3
    ops = [m.op for m in b.items]
    assert ops == ["add", "append", "event"]


def test_buffer_items_is_immutable_snapshot() -> None:
    b = MutationBuffer()
    b.append(op="add", path="bond.affection", value=+1.5, source="s14/joy")
    snap = b.items
    assert isinstance(snap, tuple)
    b.append(op="add", path="bond.trust", value=+0.5, source="s14/joy")
    # snap taken before the second append should still show 1 entry.
    assert len(snap) == 1
    assert len(b) == 2


def test_buffer_append_returns_mutation() -> None:
    b = MutationBuffer()
    m = b.append(
        op="append",
        path="recent_events",
        value="played",
        source="s10/play",
        note="user triggered play tool",
    )
    assert isinstance(m, Mutation)
    assert m.note == "user triggered play tool"
    assert m.path == "recent_events"
    assert m.value == "played"
    assert m.source == "s10/play"


def test_buffer_bool_truthy_when_nonempty() -> None:
    b = MutationBuffer()
    assert not b
    b.append(op="add", path="vitals.energy", value=-5.0, source="test")
    assert b


def test_buffer_iter_matches_items_order() -> None:
    b = MutationBuffer()
    values = [1.0, 2.0, 3.0]
    for v in values:
        b.append(op="add", path="vitals.hunger", value=v, source="t")
    assert [m.value for m in b] == values
    assert tuple(m.value for m in b.items) == tuple(values)


def test_mutation_op_type_is_literal() -> None:
    # Sanity — the alias exists and includes at least the four ops.
    # (Literal objects aren't easily introspected; this just ensures the name
    # is importable and usable as a type alias.)
    assert MutationOp is not None
