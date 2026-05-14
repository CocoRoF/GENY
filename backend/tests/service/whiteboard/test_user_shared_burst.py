"""Tests for the V2 STT-stream burst coalescer."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pytest

from service.whiteboard.types import SpotlightItem
from service.whiteboard import user_shared_burst as burst_mod


def _make_item(
    *,
    item_id: str,
    session_id: str = "sess-1",
    user_id: str = "alice",
    excerpt: str = "hello",
    metadata: Optional[Dict[str, Any]] = None,
) -> SpotlightItem:
    return SpotlightItem(
        item_id=item_id,
        user_id=user_id,
        session_id=session_id,
        source_filename=f"inbox/{item_id}.md",
        title=f"Audio memo {item_id}",
        excerpt=excerpt,
        attachments=(),
        capture_id=item_id,
        note_kind="user",
        expires_at=datetime.now(timezone.utc),
        metadata=dict(metadata or {"source": "vtuber_stt_stream"}),
    )


def _install_fire_capture(monkeypatch: pytest.MonkeyPatch) -> List[SpotlightItem]:
    """Replace the real trigger fire with a recorder so tests don't
    actually invoke the agent executor."""
    from service.whiteboard import user_shared_trigger as ust
    fired: List[SpotlightItem] = []
    monkeypatch.setattr(
        ust, "fire_user_shared_trigger_async",
        lambda item: fired.append(item),
    )
    return fired


@pytest.fixture
def _short_window(monkeypatch: pytest.MonkeyPatch):
    """Shorten the coalesce window to 50 ms so tests stay snappy."""
    monkeypatch.setattr(burst_mod, "COALESCE_WINDOW_SECONDS", 0.05)
    yield


@pytest.fixture(autouse=True)
def _drain_between_tests():
    """Make sure no pending burst from a previous test leaks into the
    next one. asyncio.run gives each test a fresh loop, but the
    module-level ``_states`` dict is process-wide."""
    yield
    try:
        asyncio.run(burst_mod._drain_for_tests())
    except RuntimeError:
        # If a test left a closed loop around just clear the dict.
        burst_mod._states.clear()


# ── Coalescing ───────────────────────────────────────────────────────


def test_single_utterance_fires_once_after_window(
    _short_window, monkeypatch: pytest.MonkeyPatch,
) -> None:
    fired = _install_fire_capture(monkeypatch)

    async def _runner() -> None:
        await burst_mod.coalesce_user_shared_trigger(
            _make_item(item_id="cap-1")
        )
        # Window hasn't expired yet — no fire.
        await asyncio.sleep(0.02)
        assert fired == []
        # Wait past the window.
        await asyncio.sleep(0.08)

    asyncio.run(_runner())
    assert len(fired) == 1
    assert fired[0].item_id == "cap-1"


def test_burst_of_three_collapses_to_one_trigger(
    _short_window, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Three utterances arriving within the coalesce window must
    produce exactly ONE trigger fire against the latest item — that's
    the whole point of the debouncer."""
    fired = _install_fire_capture(monkeypatch)

    async def _runner() -> None:
        await burst_mod.coalesce_user_shared_trigger(
            _make_item(item_id="cap-1", excerpt="안녕")
        )
        await asyncio.sleep(0.02)
        await burst_mod.coalesce_user_shared_trigger(
            _make_item(item_id="cap-2", excerpt="잠깐만")
        )
        await asyncio.sleep(0.02)
        await burst_mod.coalesce_user_shared_trigger(
            _make_item(item_id="cap-3", excerpt="방금 그거 뭐였지")
        )
        # Now silence — wait past the window from the LAST add.
        await asyncio.sleep(0.1)

    asyncio.run(_runner())

    assert len(fired) == 1, f"expected 1 coalesced fire, got {len(fired)}"
    assert fired[0].item_id == "cap-3", (
        "coalescer must fire the most recent item — that's the one "
        "the persona's surrounding spotlight context is centred on"
    )


def test_separate_bursts_fire_independently(
    _short_window, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two bursts separated by more than the coalesce window fire
    one trigger each — debouncing collapses within a burst, not
    across an entire session."""
    fired = _install_fire_capture(monkeypatch)

    async def _runner() -> None:
        await burst_mod.coalesce_user_shared_trigger(_make_item(item_id="a-1"))
        await asyncio.sleep(0.1)  # past the window → fires
        await burst_mod.coalesce_user_shared_trigger(_make_item(item_id="b-1"))
        await asyncio.sleep(0.1)  # past again → fires

    asyncio.run(_runner())

    assert [f.item_id for f in fired] == ["a-1", "b-1"]


def test_different_sessions_do_not_share_buffer(
    _short_window, monkeypatch: pytest.MonkeyPatch,
) -> None:
    fired = _install_fire_capture(monkeypatch)

    async def _runner() -> None:
        await burst_mod.coalesce_user_shared_trigger(
            _make_item(item_id="alice-1", session_id="alice-sess")
        )
        await burst_mod.coalesce_user_shared_trigger(
            _make_item(item_id="bob-1", session_id="bob-sess", user_id="bob")
        )
        await asyncio.sleep(0.1)

    asyncio.run(_runner())

    # Both bursts fire — they're keyed by (user, session).
    ids = sorted(f.item_id for f in fired)
    assert ids == ["alice-1", "bob-1"]


def test_no_session_id_is_silent_noop(
    _short_window, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Items without a session can't reach an agent — no trigger,
    no error."""
    fired = _install_fire_capture(monkeypatch)

    async def _runner() -> None:
        item = SpotlightItem(
            item_id="orphan",
            user_id="alice",
            session_id=None,
            source_filename="inbox/x.md",
            title="x",
            excerpt="",
            attachments=(),
            capture_id="cap",
            note_kind="user",
            expires_at=datetime.now(timezone.utc),
            metadata={"source": "vtuber_stt_stream"},
        )
        await burst_mod.coalesce_user_shared_trigger(item)
        await asyncio.sleep(0.1)

    asyncio.run(_runner())
    assert fired == []


# ── Cancel helper ────────────────────────────────────────────────────


def test_cancel_pending_drops_the_burst(
    _short_window, monkeypatch: pytest.MonkeyPatch,
) -> None:
    fired = _install_fire_capture(monkeypatch)

    async def _runner() -> None:
        await burst_mod.coalesce_user_shared_trigger(
            _make_item(item_id="cap-1")
        )
        # Cancel before the window expires.
        cancelled = await burst_mod.cancel_pending_for_session(
            "alice", "sess-1"
        )
        assert cancelled is not None and cancelled.item_id == "cap-1"
        # Wait past the window — nothing should fire.
        await asyncio.sleep(0.1)

    asyncio.run(_runner())
    assert fired == []


def test_cancel_pending_returns_none_when_empty() -> None:
    async def _runner() -> None:
        out = await burst_mod.cancel_pending_for_session(
            "alice", "no-such-session"
        )
        assert out is None

    asyncio.run(_runner())
