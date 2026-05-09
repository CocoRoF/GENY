"""Unit tests for ``service.whiteboard.spotlight_store``."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from service.whiteboard.spotlight_store import (
    DEFAULT_TTL_MINUTES,
    MAX_PER_SESSION,
    SpotlightStore,
)


@pytest.fixture()
def store() -> SpotlightStore:
    return SpotlightStore()


def test_add_returns_item_with_expiration(store: SpotlightStore) -> None:
    before = datetime.now(timezone.utc)
    item = store.add(
        user_id="alice",
        session_id="sess-1",
        source_filename="topics/foo.md",
        title="Foo",
        excerpt="hello",
    )
    after = datetime.now(timezone.utc)
    assert item.title == "Foo"
    assert item.expires_at is not None
    expected_min = before + timedelta(minutes=DEFAULT_TTL_MINUTES) - timedelta(seconds=2)
    expected_max = after + timedelta(minutes=DEFAULT_TTL_MINUTES) + timedelta(seconds=2)
    assert expected_min <= item.expires_at <= expected_max


def test_list_filters_expired_by_default(store: SpotlightStore) -> None:
    store.add(
        user_id="alice",
        session_id="sess-1",
        source_filename="topics/a.md",
        title="A",
        excerpt="",
        ttl_minutes=1,
    )
    # Expire by mutating in place — easier than waiting.
    items = store.list(user_id="alice", session_id="sess-1", include_expired=True)
    items[0].expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert store.list(user_id="alice", session_id="sess-1") == []
    assert len(store.list(user_id="alice", session_id="sess-1", include_expired=True)) == 1


def test_pinned_items_never_expire(store: SpotlightStore) -> None:
    store.add(
        user_id="alice",
        session_id="sess-1",
        source_filename="topics/a.md",
        title="A",
        excerpt="",
        pinned=True,
    )
    items = store.list(user_id="alice", session_id="sess-1", include_expired=True)
    items[0].expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert len(store.list(user_id="alice", session_id="sess-1")) == 1


def test_users_are_isolated(store: SpotlightStore) -> None:
    store.add(user_id="alice", session_id="s", source_filename="a.md", title="A", excerpt="")
    store.add(user_id="bob", session_id="s", source_filename="b.md", title="B", excerpt="")
    assert len(store.list(user_id="alice", session_id="s")) == 1
    assert len(store.list(user_id="bob", session_id="s")) == 1


def test_remove_returns_false_for_unknown(store: SpotlightStore) -> None:
    assert store.remove(user_id="alice", item_id="nope") is False


def test_remove_drops_item(store: SpotlightStore) -> None:
    item = store.add(
        user_id="alice", session_id="s", source_filename="a.md", title="A", excerpt=""
    )
    assert store.remove(user_id="alice", item_id=item.item_id) is True
    assert store.list(user_id="alice", session_id="s") == []


def test_max_per_session_evicts_oldest_unpinned(store: SpotlightStore) -> None:
    pinned = store.add(
        user_id="alice", session_id="s", source_filename="pinned.md", title="P", excerpt="", pinned=True
    )
    for i in range(MAX_PER_SESSION + 5):
        store.add(
            user_id="alice", session_id="s", source_filename=f"n{i}.md", title=f"N{i}", excerpt=""
        )
    items = store.list(user_id="alice", session_id="s", include_expired=True)
    assert len(items) <= MAX_PER_SESSION
    # The pinned item must still be there.
    assert any(item.item_id == pinned.item_id for item in items)


def test_eviction_keeps_pinned_only_when_all_pinned(store: SpotlightStore) -> None:
    """If every existing item is pinned, the eviction loop must not
    spin forever and must still allow the new add (the bucket can
    legally exceed MAX in this corner case — that's pinned semantics)."""
    for i in range(MAX_PER_SESSION + 2):
        store.add(
            user_id="alice",
            session_id="s",
            source_filename=f"p{i}.md",
            title=f"P{i}",
            excerpt="",
            pinned=True,
        )
    items = store.list(user_id="alice", session_id="s", include_expired=True)
    # All pinned → cap can't shed any of them, so we end up with
    # MAX_PER_SESSION + 2. The important assertion is "doesn't hang".
    assert len(items) == MAX_PER_SESSION + 2
    assert all(item.pinned for item in items)


def test_list_merges_user_wide_and_session_specific(store: SpotlightStore) -> None:
    """When ``session_id`` is set, the user-wide bucket is merged in.

    This is the invariant that lets a note shared from the inbox UI
    (no active session) reach the VTuber's prompt build for any
    running session: the user-wide bucket is always visible.
    """
    user_wide = store.add(
        user_id="alice",
        session_id=None,
        source_filename="topics/global.md",
        title="Global",
        excerpt="",
    )
    session_only = store.add(
        user_id="alice",
        session_id="sess-1",
        source_filename="topics/local.md",
        title="Local",
        excerpt="",
    )
    out = store.list(user_id="alice", session_id="sess-1")
    ids = {item.item_id for item in out}
    assert user_wide.item_id in ids
    assert session_only.item_id in ids


def test_list_user_wide_only_when_session_id_none(store: SpotlightStore) -> None:
    store.add(
        user_id="alice",
        session_id=None,
        source_filename="g.md",
        title="G",
        excerpt="",
    )
    store.add(
        user_id="alice",
        session_id="sess-1",
        source_filename="s.md",
        title="S",
        excerpt="",
    )
    out = store.list(user_id="alice", session_id=None)
    assert len(out) == 1
    assert out[0].source_filename == "g.md"


def test_list_dedupes_by_item_id(store: SpotlightStore) -> None:
    # Defence-in-depth — same item_id must not show twice if a future
    # writer accidentally lands the same item in both buckets.
    item = store.add(
        user_id="alice",
        session_id=None,
        source_filename="x.md",
        title="X",
        excerpt="",
    )
    # Hand-craft a second insertion of the same item_id into the
    # session bucket via the internal dict.
    with store._lock:  # noqa: SLF001
        store._items[("alice", "sess-1")] = [item]  # noqa: SLF001
    out = store.list(user_id="alice", session_id="sess-1")
    assert len([i for i in out if i.item_id == item.item_id]) == 1


def test_expire_due_removes_only_expired(store: SpotlightStore) -> None:
    fresh = store.add(
        user_id="alice", session_id="s", source_filename="f.md", title="F", excerpt=""
    )
    stale = store.add(
        user_id="alice", session_id="s", source_filename="s.md", title="S", excerpt=""
    )
    items = store.list(user_id="alice", session_id="s", include_expired=True)
    for item in items:
        if item.item_id == stale.item_id:
            item.expires_at = datetime.now(timezone.utc) - timedelta(minutes=10)

    removed = store.expire_due()
    assert removed == 1
    remaining = store.list(user_id="alice", session_id="s", include_expired=True)
    assert any(it.item_id == fresh.item_id for it in remaining)
    assert all(it.item_id != stale.item_id for it in remaining)
