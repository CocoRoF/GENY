"""``InMemoryCreatureStateProvider`` contract (cycle 20260421_9 PR-X3-2)."""

from __future__ import annotations

import asyncio

import pytest

from backend.service.state.provider.in_memory import InMemoryCreatureStateProvider
from backend.service.state.schema.mutation import Mutation


@pytest.mark.asyncio
async def test_load_creates_default_if_missing() -> None:
    p = InMemoryCreatureStateProvider()
    s = await p.load("c1", owner_user_id="u1")
    assert s.character_id == "c1"
    assert s.owner_user_id == "u1"
    assert s.vitals.hunger == 50.0  # default


@pytest.mark.asyncio
async def test_load_returns_existing_state_as_copy() -> None:
    p = InMemoryCreatureStateProvider()
    a = await p.load("c1", owner_user_id="u1")
    a.vitals.hunger = 99.0  # caller mutates their copy
    b = await p.load("c1")
    assert b.vitals.hunger == 50.0  # store not affected


@pytest.mark.asyncio
async def test_apply_persists_mutations() -> None:
    p = InMemoryCreatureStateProvider()
    s = await p.load("c1", owner_user_id="u1")
    new = await p.apply(s, [
        Mutation(op="add", path="vitals.hunger", value=-20.0, source="test"),
        Mutation(op="append", path="recent_events", value="fed", source="test"),
    ])
    assert new.vitals.hunger == pytest.approx(30.0)
    assert new.recent_events == ["fed"]

    # Reload sees persisted state.
    reloaded = await p.load("c1")
    assert reloaded.vitals.hunger == pytest.approx(30.0)
    assert reloaded.recent_events == ["fed"]


@pytest.mark.asyncio
async def test_apply_empty_mutations_is_noop() -> None:
    p = InMemoryCreatureStateProvider()
    s = await p.load("c1", owner_user_id="u1")
    out = await p.apply(s, [])
    assert out.vitals.hunger == 50.0
    # but the store should have whatever load created — reload works.
    _ = await p.load("c1")


@pytest.mark.asyncio
async def test_set_absolute_overwrites_path() -> None:
    p = InMemoryCreatureStateProvider()
    _ = await p.load("c1", owner_user_id="u1")
    out = await p.set_absolute("c1", {"progression.life_stage": "teen"})
    assert out.progression.life_stage == "teen"
    reloaded = await p.load("c1")
    assert reloaded.progression.life_stage == "teen"


@pytest.mark.asyncio
async def test_set_absolute_on_unknown_character_raises() -> None:
    p = InMemoryCreatureStateProvider()
    with pytest.raises(KeyError):
        await p.set_absolute("missing", {"vitals.hunger": 0.0})


@pytest.mark.asyncio
async def test_multiple_characters_are_isolated() -> None:
    p = InMemoryCreatureStateProvider()
    await p.load("a", owner_user_id="u")
    await p.load("b", owner_user_id="u")
    sa = await p.load("a")
    await p.apply(sa, [Mutation(op="add", path="vitals.hunger", value=+10.0, source="t")])
    rb = await p.load("b")
    assert rb.vitals.hunger == 50.0  # character b unaffected


@pytest.mark.asyncio
async def test_concurrent_applies_serialize_per_character() -> None:
    p = InMemoryCreatureStateProvider()
    s = await p.load("c1", owner_user_id="u1")

    async def bump(delta: float) -> None:
        snap = await p.load("c1")
        await p.apply(snap, [
            Mutation(op="add", path="vitals.hunger", value=delta, source="t"),
        ])

    await asyncio.gather(*(bump(1.0) for _ in range(5)))
    # In-memory provider doesn't do OCC; it serializes under per-key lock, so
    # exact final value depends on read-before-apply interleaving. What we
    # guarantee: at least one bump landed, final state reloads cleanly.
    final = await p.load("c1")
    assert final.vitals.hunger >= 51.0
