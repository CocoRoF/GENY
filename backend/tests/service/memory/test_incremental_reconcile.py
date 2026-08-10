"""Boot reconciliation — effect-proving tests.

The write path indexes notes as they are written, so on a healthy session
there is nothing for boot to do. Boot exists for the cases where the index
and the notes drifted apart, and the question is how it FINDS the drift.

Offering every note to the engine finds edits, at the cost of re-reading the
whole vault and taking the engine lock once per note — 5,507 times on the
production vault to discover that nothing changed. And it cannot find
deletions at all: iterating the files that exist never visits the ones that
don't, which is how 36% of that index became nodes whose notes were gone.

These tests pin the properties a metadata diff must have:
  · unchanged notes are never re-read and never reach the engine;
  · an edited note is;
  · a deleted note's index entry is reaped;
  · a store that cannot answer "what is indexed?" still gets reconciled.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Dict, List, Tuple

import pytest

from service.memory.manager import SessionMemoryManager


class _Ref:
    def __init__(self, filename: str, category: str = "observations") -> None:
        self.filename = filename
        self.category = category
        self.scope = "Scope.SESSION"


class _Notes:
    """Vault stand-in. Counts body reads — the cost the diff must avoid."""

    def __init__(self, notes: Dict[str, Tuple[str, datetime]]) -> None:
        self._notes = notes
        self.reads: List[str] = []

    async def list(self):
        return [
            SimpleNamespace(ref=_Ref(name), updated_at=ts)
            for name, (_body, ts) in self._notes.items()
        ]

    async def read(self, filename: str):
        self.reads.append(filename)
        entry = self._notes.get(filename)
        if entry is None:
            return None
        return SimpleNamespace(ref=_Ref(filename), body=entry[0])


class _Vector:
    def __init__(self, manifest: Dict[str, Tuple[float, str]]) -> None:
        self._manifest = dict(manifest)
        self.indexed: List[str] = []
        self.removed: List[str] = []

    def node_id_for(self, ref) -> str:
        return f"{ref.scope}/{ref.category}/{ref.filename}"

    async def manifest(self):
        return dict(self._manifest)

    async def index_batch(self, items):
        self.indexed.extend(ref.filename for ref, _ in items)
        return len(items)

    async def remove_many(self, node_ids):
        self.removed.extend(node_ids)
        return len(node_ids)


def _mgr(notes, vector) -> SessionMemoryManager:
    mgr = SessionMemoryManager.__new__(SessionMemoryManager)
    mgr._memory_provider = SimpleNamespace(notes=lambda: notes, vector=lambda: vector)
    return mgr


def _node(name: str) -> str:
    return f"Scope.SESSION/observations/{name}"


NOW = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)
INDEXED_AT = NOW.timestamp()


@pytest.mark.asyncio
async def test_a_vault_in_sync_costs_nothing():
    """THE property. Every note is already indexed and unchanged, so no body
    is read and the engine is never called."""
    notes = _Notes({f"n{i}.md": ("본문", NOW) for i in range(50)})
    vector = _Vector({_node(f"n{i}.md"): (INDEXED_AT, "sha") for i in range(50)})

    assert await _mgr(notes, vector)._vector_initialize_and_index() is True

    assert notes.reads == [], f"re-read {len(notes.reads)} unchanged notes"
    assert vector.indexed == []
    assert vector.removed == []


@pytest.mark.asyncio
async def test_a_note_edited_since_indexing_is_reindexed():
    notes = _Notes({
        "old.md": ("본문", NOW - timedelta(hours=1)),
        "edited.md": ("바뀐 본문", NOW + timedelta(minutes=5)),
    })
    vector = _Vector({
        _node("old.md"): (INDEXED_AT, "sha"),
        _node("edited.md"): (INDEXED_AT, "sha"),
    })

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert vector.indexed == ["edited.md"]
    assert notes.reads == ["edited.md"], "read a note it did not need"


@pytest.mark.asyncio
async def test_a_note_never_indexed_is_picked_up():
    """Notes written while the index was unavailable — the case boot is for."""
    notes = _Notes({"known.md": ("본문", NOW), "new.md": ("새 본문", NOW)})
    vector = _Vector({_node("known.md"): (INDEXED_AT, "sha")})

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert vector.indexed == ["new.md"]


@pytest.mark.asyncio
async def test_a_deleted_notes_index_entry_is_reaped():
    """The failure a forward scan cannot even see: the file is gone, so it is
    never iterated, so the node stays in the index forever. 36% of the
    production index was this."""
    notes = _Notes({"alive.md": ("본문", NOW)})
    vector = _Vector({
        _node("alive.md"): (INDEXED_AT, "sha"),
        _node("deleted-1.md"): (INDEXED_AT, "sha"),
        _node("deleted-2.md"): (INDEXED_AT, "sha"),
    })

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert sorted(vector.removed) == [_node("deleted-1.md"), _node("deleted-2.md")]
    assert vector.indexed == []


@pytest.mark.asyncio
async def test_a_survivor_is_never_reaped():
    notes = _Notes({f"keep{i}.md": ("본문", NOW) for i in range(5)})
    vector = _Vector({_node(f"keep{i}.md"): (INDEXED_AT, "sha") for i in range(5)})

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert vector.removed == []


@pytest.mark.asyncio
async def test_equal_timestamps_are_not_drift():
    """The index records when IT wrote, which equals the note's stamp for a
    note indexed on write. Treating equality as drift would re-index the
    entire vault on every boot — the exact waste being removed."""
    notes = _Notes({"n.md": ("본문", NOW)})
    vector = _Vector({_node("n.md"): (NOW.timestamp(), "sha")})

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert vector.indexed == []


@pytest.mark.asyncio
async def test_an_empty_note_is_not_indexed():
    notes = _Notes({"empty.md": ("", NOW)})
    vector = _Vector({})

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert vector.indexed == []


@pytest.mark.asyncio
async def test_a_store_without_a_manifest_still_gets_reconciled():
    """Slow is recoverable; a silently un-indexed vault is not."""

    class _Old:
        def __init__(self):
            self.indexed: List[str] = []

        def node_id_for(self, ref):
            return ref.filename

        async def index_batch(self, items):
            self.indexed.extend(ref.filename for ref, _ in items)
            return len(items)

    notes = _Notes({"a.md": ("본문", NOW), "b.md": ("본문", NOW)})
    old = _Old()

    assert await _mgr(notes, old)._vector_initialize_and_index() is True
    assert sorted(old.indexed) == ["a.md", "b.md"]


@pytest.mark.asyncio
async def test_a_failing_manifest_does_not_break_the_session():
    class _Broken(_Vector):
        async def manifest(self):
            raise RuntimeError("index unreadable")

    notes = _Notes({"a.md": ("본문", NOW)})

    assert await _mgr(notes, _Broken({}))._vector_initialize_and_index() is False


# ── a full-vault invalidation must not blow the warm-up budget ──────

@pytest.mark.asyncio
async def test_a_large_reindex_is_split_off_the_boot_path(monkeypatch):
    """A tokenizer or embedding-geometry change invalidates EVERY note at
    once. The warm-up that calls this is bounded at 90s, so applying
    thousands inline means it is cancelled on every boot, memory never
    reports ready, and the session answers blind."""
    from service.memory.manager import SessionMemoryManager

    spawned = []
    monkeypatch.setattr(
        "service.memory.manager.spawn_background",
        lambda coro, **kw: (spawned.append(kw.get("name")), coro.close()),
    )

    n = SessionMemoryManager._RECONCILE_INLINE + 350
    notes = _Notes({f"n{i}.md": ("본문", NOW) for i in range(n)})
    vector = _Vector({})            # nothing indexed → every note is stale

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert vector.indexed == [], (
        "a conversion did work inline; the warm-up budget cancels it before "
        "the first chunk commits and the conversion never starts"
    )
    assert spawned and "reconcile-tail" in spawned[0]


@pytest.mark.asyncio
async def test_ordinary_drift_still_finishes_inline(monkeypatch):
    """The common case is a handful of notes; handing those to a background
    task would leave memory reporting ready before it is."""
    from service.memory.manager import SessionMemoryManager

    spawned = []
    monkeypatch.setattr(
        "service.memory.manager.spawn_background",
        lambda coro, **kw: (spawned.append(kw.get("name")), coro.close()),
    )

    notes = _Notes({f"n{i}.md": ("본문", NOW) for i in range(5)})
    vector = _Vector({})

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert len(vector.indexed) == 5
    assert spawned == []


@pytest.mark.asyncio
async def test_the_background_pass_covers_the_remainder():
    from service.memory.manager import SessionMemoryManager

    mgr = SessionMemoryManager.__new__(SessionMemoryManager)
    notes = _Notes({f"n{i}.md": ("본문", NOW) for i in range(450)})
    vector = _Vector({})
    metas = await notes.list()

    await mgr._reconcile_tail(notes, vector, metas)

    assert len(vector.indexed) == 450


@pytest.mark.asyncio
async def test_an_empty_digest_means_reindex():
    """The engine reports "indexed, derived state unknown" by emptying the
    digest — that is how a tokenizer or embedding-geometry change reaches a
    host that otherwise diffs on timestamps. Production upgraded its
    tokenizer and re-indexed nothing until this was read."""
    notes = _Notes({"stale.md": ("본문", NOW), "fine.md": ("본문", NOW)})
    vector = _Vector({
        _node("stale.md"): (INDEXED_AT, ""),        # geometry moved
        _node("fine.md"): (INDEXED_AT, "sha"),
    })

    await _mgr(notes, vector)._vector_initialize_and_index()

    assert vector.indexed == ["stale.md"]
