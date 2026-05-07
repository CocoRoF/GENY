"""Tests for the ``mentioned`` heuristic."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from service.whiteboard import mentioned_heuristic, view_ledger
from service.whiteboard.mentioned_heuristic import (
    detect_mentions,
    maybe_record_mentions,
)


def test_detect_mentions_finds_title_substring() -> None:
    hits = detect_mentions(
        "Looks like the API debugging memo covers this.",
        candidates=[("topics/api-debug.md", "API debugging memo")],
    )
    assert hits == ["topics/api-debug.md"]


def test_detect_mentions_skips_too_short_titles() -> None:
    # Three-character titles are filtered out — they would match
    # every other word in a normal response.
    hits = detect_mentions(
        "let's talk about api now.",
        candidates=[("topics/api.md", "api")],
    )
    assert hits == []


def test_detect_mentions_falls_back_to_filename() -> None:
    hits = detect_mentions(
        "see the topics/api-debug entry from yesterday",
        candidates=[("topics/api-debug.md", "")],
    )
    assert hits == ["topics/api-debug.md"]


def test_detect_mentions_dedupes_per_candidate() -> None:
    hits = detect_mentions(
        "the api debugging memo, and again the api debugging memo",
        candidates=[("topics/api-debug.md", "API debugging memo")],
    )
    assert hits == ["topics/api-debug.md"]


def test_maybe_record_disabled_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GENY_WHITEBOARD_TRACK_MENTIONED", raising=False)
    n = maybe_record_mentions(session_id="s", response_text="anything")
    assert n == 0


def test_maybe_record_records_on_match(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("GENY_WHITEBOARD_TRACK_MENTIONED", "1")

    # Wire up a real ledger and a fake resolver.
    ledger = view_ledger.ViewLedger(
        base_path=str(tmp_path), username="alice", agent_id="cocoro"
    )

    monkeypatch.setattr(
        mentioned_heuristic,
        "resolve_user_and_agent",
        lambda session_id: ("alice", "cocoro"),
        raising=False,
    )
    monkeypatch.setattr(
        mentioned_heuristic, "get_view_ledger", lambda u, a: ledger,
        raising=False,
    )

    # Stub the spotlight store with one item.
    from service.whiteboard import spotlight_store as ss

    store = ss.get_spotlight_store()
    store.reset_for_tests()
    store.add(
        user_id="alice",
        session_id="s",
        source_filename="topics/api-debug.md",
        title="API debugging memo",
        excerpt="...",
    )

    n = maybe_record_mentions(
        session_id="s",
        response_text="So as the API debugging memo says, …",
    )
    assert n == 1
    rec = ledger.get("topics/api-debug.md")
    assert rec is not None
    assert rec.counts.get("mentioned") == 1


def test_maybe_record_short_text_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GENY_WHITEBOARD_TRACK_MENTIONED", "1")
    assert maybe_record_mentions(session_id="s", response_text="ok") == 0
