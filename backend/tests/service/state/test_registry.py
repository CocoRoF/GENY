"""``SessionRuntimeRegistry`` contract (cycle 20260421_9 PR-X3-3).

Tests use a small ``_StubState`` that matches the pieces of
``PipelineState`` the registry touches: ``.shared`` dict + optional
``.add_event``. This keeps these tests fast and avoids dragging
executor internals into the schema suite.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import pytest

from backend.service.state.hydrator import hydrate_state, persist_state
from backend.service.state.provider.in_memory import (
    InMemoryCreatureStateProvider,
)
from backend.service.state.provider.interface import StateConflictError
from backend.service.state.registry import (
    CREATURE_STATE_KEY,
    MUTATION_BUFFER_KEY,
    SESSION_META_KEY,
    SessionRuntimeRegistry,
)
from backend.service.state.schema.creature_state import CreatureState
from backend.service.state.schema.mutation import Mutation, MutationBuffer


class _StubState:
    def __init__(self, *, with_events: bool = True) -> None:
        self.shared: Dict[str, Any] = {}
        self._events: List[Tuple[str, Dict[str, Any]]] = []
        self._with_events = with_events

    def add_event(self, name: str, payload: Dict[str, Any]) -> None:
        if not self._with_events:
            raise RuntimeError("event sink deliberately broken")
        self._events.append((name, payload))

    @property
    def events(self) -> List[Tuple[str, Dict[str, Any]]]:
        return self._events


def _mk_registry(
    provider=None,
    *,
    session_id: str = "sess-1",
    character_id: str = "c1",
    owner_user_id: str = "u1",
) -> Tuple[SessionRuntimeRegistry, InMemoryCreatureStateProvider]:
    prov = provider or InMemoryCreatureStateProvider()
    reg = SessionRuntimeRegistry(
        session_id=session_id,
        character_id=character_id,
        owner_user_id=owner_user_id,
        provider=prov,
    )
    return reg, prov


@pytest.mark.asyncio
async def test_hydrate_installs_keys_on_shared() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    snap = await reg.hydrate(state)

    assert isinstance(snap, CreatureState)
    assert state.shared[CREATURE_STATE_KEY] is snap
    assert isinstance(state.shared[MUTATION_BUFFER_KEY], MutationBuffer)
    assert len(state.shared[MUTATION_BUFFER_KEY]) == 0
    meta = state.shared[SESSION_META_KEY]
    assert meta["session_id"] == "sess-1"
    assert meta["character_id"] == "c1"
    assert meta["owner_user_id"] == "u1"


@pytest.mark.asyncio
async def test_hydrate_emits_hydrated_event() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    await reg.hydrate(state)
    names = [n for n, _ in state.events]
    assert "state.hydrated" in names
    payload = dict(state.events[0][1])
    assert payload["character_id"] == "c1"
    assert payload["session_id"] == "sess-1"
    assert "last_tick_at" in payload


@pytest.mark.asyncio
async def test_hydrate_propagates_snapshot_as_provider_result() -> None:
    reg, prov = _mk_registry()
    direct = await prov.load("c1", owner_user_id="u1")
    state = _StubState()
    snap = await reg.hydrate(state)
    assert snap.character_id == direct.character_id
    assert snap.owner_user_id == direct.owner_user_id


@pytest.mark.asyncio
async def test_persist_without_hydrate_raises_runtime_error() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    with pytest.raises(RuntimeError):
        await reg.persist(state)


@pytest.mark.asyncio
async def test_persist_requires_mutation_buffer_key() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    await reg.hydrate(state)
    # Corrupt the buffer slot.
    state.shared[MUTATION_BUFFER_KEY] = "not-a-buffer"
    with pytest.raises(RuntimeError):
        await reg.persist(state)


@pytest.mark.asyncio
async def test_persist_applies_mutations_from_buffer() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    await reg.hydrate(state)
    buf: MutationBuffer = state.shared[MUTATION_BUFFER_KEY]
    buf.append(op="add", path="vitals.hunger", value=-10.0, source="test")
    buf.append(op="append", path="recent_events", value="fed", source="test")

    new_state = await reg.persist(state)
    assert new_state.vitals.hunger == pytest.approx(40.0)
    assert new_state.recent_events == ["fed"]
    # Shared key replaced with the persisted state.
    assert state.shared[CREATURE_STATE_KEY] is new_state


@pytest.mark.asyncio
async def test_persist_emits_persisted_event_with_mutation_count() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    await reg.hydrate(state)
    buf: MutationBuffer = state.shared[MUTATION_BUFFER_KEY]
    buf.append(op="add", path="vitals.hunger", value=-1.0, source="test")
    buf.append(op="add", path="bond.affection", value=+2.0, source="test")
    await reg.persist(state)

    persisted = [p for n, p in state.events if n == "state.persisted"]
    assert persisted, "expected state.persisted event"
    assert persisted[0]["mutations"] == 2
    assert persisted[0]["character_id"] == "c1"


@pytest.mark.asyncio
async def test_persist_empty_buffer_is_noop_but_still_emits_event() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    snap = await reg.hydrate(state)
    out = await reg.persist(state)
    # In-memory provider's empty-mutation fast path returns the same snapshot
    # instance, so out is identity-equal to snap.
    assert out is snap
    persisted = [p for n, p in state.events if n == "state.persisted"]
    assert persisted and persisted[0]["mutations"] == 0


@pytest.mark.asyncio
async def test_persist_emits_conflict_and_reraises(monkeypatch) -> None:
    reg, prov = _mk_registry()
    state = _StubState()
    await reg.hydrate(state)
    buf: MutationBuffer = state.shared[MUTATION_BUFFER_KEY]
    buf.append(op="add", path="vitals.hunger", value=-1.0, source="t")

    async def boom(*a, **kw):
        raise StateConflictError("simulated")

    monkeypatch.setattr(prov, "apply", boom)
    with pytest.raises(StateConflictError):
        await reg.persist(state)
    conflict = [p for n, p in state.events if n == "state.conflict"]
    assert conflict and conflict[0]["character_id"] == "c1"
    assert conflict[0]["mutations"] == 1


@pytest.mark.asyncio
async def test_hydrate_persist_works_without_add_event() -> None:
    """State objects without ``add_event`` must not break the registry."""

    class _NoEventState:
        def __init__(self) -> None:
            self.shared: Dict[str, Any] = {}

    reg, _ = _mk_registry()
    st: Any = _NoEventState()
    snap = await reg.hydrate(st)
    assert snap is not None
    st.shared[MUTATION_BUFFER_KEY].append(
        op="add", path="vitals.hunger", value=-2.0, source="t",
    )
    new = await reg.persist(st)
    assert new.vitals.hunger == pytest.approx(48.0)


@pytest.mark.asyncio
async def test_event_sink_errors_are_swallowed() -> None:
    """If add_event raises, hydrate/persist still succeed."""
    reg, _ = _mk_registry()
    state = _StubState(with_events=False)
    # hydrate should not raise even though add_event blows up internally.
    snap = await reg.hydrate(state)
    assert isinstance(snap, CreatureState)
    state.shared[MUTATION_BUFFER_KEY].append(
        op="add", path="bond.affection", value=+1.0, source="t",
    )
    out = await reg.persist(state)
    assert out.bond.affection == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_registry_snapshot_tracks_latest_after_persist() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    await reg.hydrate(state)
    state.shared[MUTATION_BUFFER_KEY].append(
        op="add", path="vitals.hunger", value=-5.0, source="t",
    )
    new = await reg.persist(state)
    assert reg.snapshot is new  # updated to persisted state


@pytest.mark.asyncio
async def test_hydrator_free_functions_dispatch_to_registry() -> None:
    reg, _ = _mk_registry()
    state = _StubState()
    snap = await hydrate_state(state, reg)
    assert isinstance(snap, CreatureState)
    state.shared[MUTATION_BUFFER_KEY].append(
        op="add", path="vitals.hunger", value=-3.0, source="t",
    )
    out = await persist_state(state, reg)
    assert out.vitals.hunger == pytest.approx(47.0)


@pytest.mark.asyncio
async def test_state_without_shared_raises_attribute_error() -> None:
    class _Broken:
        pass

    reg, _ = _mk_registry()
    with pytest.raises(AttributeError):
        await reg.hydrate(_Broken())  # type: ignore[arg-type]
