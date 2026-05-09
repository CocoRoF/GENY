"""Tests for the Organizer strategies and persistence layer."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict

import pytest

from service.whiteboard import organizer
from service.whiteboard.organizer import (
    EmbeddingClusterStrategy,
    NearDuplicateStrategy,
    OrganizationSuggestion,
    StaleUnseenStrategy,
    TopicPromotionStrategy,
    add_suggestions,
    list_active_suggestions,
    load_suggestions,
    update_status,
)
from service.whiteboard.types import ViewKey, ViewRecord
from service.whiteboard.view_ledger import ViewLedgerSnapshot


def _note(filename: str, body: str = "", *, title: str = "", category: str = "topics", created_days_ago: int = 1) -> Dict[str, Any]:
    return {
        "filename": filename,
        "title": title or filename,
        "body": body,
        "category": category,
        "created": (
            datetime.now(timezone.utc) - timedelta(days=created_days_ago)
        ).isoformat(),
    }


def _empty_snapshot() -> ViewLedgerSnapshot:
    return ViewLedgerSnapshot({})


def _snapshot_with(records: Dict[str, Dict[str, int]]) -> ViewLedgerSnapshot:
    """Build a snapshot with explicit per-event counts."""
    bucket: Dict[ViewKey, ViewRecord] = {}
    now = datetime.now(timezone.utc)
    for fn, counts in records.items():
        key = ViewKey(agent_id="cocoro", note_id=fn)
        rec = ViewRecord(
            key=key,
            first_seen_at=now - timedelta(days=2),
            last_seen_at=now,
            counts=dict(counts),
            last_event=next(iter(counts), None),
        )
        bucket[key] = rec
    return ViewLedgerSnapshot(bucket)


# ── EmbeddingClusterStrategy ─────────────────────────────────────────


def test_cluster_strategy_groups_similar_notes() -> None:
    notes = [
        _note("a.md", "API debug error stacktrace authentication"),
        _note("b.md", "API debug error retry authentication"),
        _note("c.md", "API authentication error session"),
        _note("d.md", "soup recipe carrots onions"),
        _note("e.md", "soup recipe stock vegetables"),
        _note("f.md", "soup recipe boiling pot stock"),
    ]
    strat = EmbeddingClusterStrategy(min_cluster_size=3, similarity_threshold=0.2)
    suggestions = strat.propose(notes, {}, _empty_snapshot())

    assert len(suggestions) == 2  # one cluster per topical group
    grouped: set[frozenset[str]] = {
        frozenset(s.note_filenames) for s in suggestions
    }
    assert frozenset({"a.md", "b.md", "c.md"}) in grouped
    assert frozenset({"d.md", "e.md", "f.md"}) in grouped


def test_cluster_strategy_skips_when_too_few_notes() -> None:
    strat = EmbeddingClusterStrategy(min_cluster_size=3)
    out = strat.propose([_note("a.md", "x")], {}, _empty_snapshot())
    assert out == []


# ── NearDuplicateStrategy ────────────────────────────────────────────


def test_duplicate_strategy_detects_high_overlap() -> None:
    notes = [
        _note("a.md", "alpha beta gamma delta epsilon zeta eta theta"),
        _note("b.md", "alpha beta gamma delta epsilon zeta eta theta"),
        _note("c.md", "completely unrelated text apples oranges"),
    ]
    out = NearDuplicateStrategy(similarity_threshold=0.9).propose(
        notes, {}, _empty_snapshot()
    )
    assert len(out) == 1
    assert set(out[0].note_filenames) == {"a.md", "b.md"}
    assert out[0].proposed_action == "merge"


# ── TopicPromotionStrategy ──────────────────────────────────────────


def test_topic_promotion_only_inbox_notes_with_views() -> None:
    notes = [
        _note("inbox/foo.md", category="inbox", created_days_ago=10),
        _note("inbox/cold.md", category="inbox", created_days_ago=10),
        _note("topics/bar.md", category="topics", created_days_ago=10),
    ]
    snapshot = _snapshot_with(
        {
            "inbox/foo.md": {"read": 3, "injected": 2},   # 5 total — promotable
            "inbox/cold.md": {"read": 1},                  # 1 total — below threshold
        }
    )
    out = TopicPromotionStrategy(min_age_days=2, min_view_activity=4).propose(
        notes, {}, snapshot
    )
    assert {s.note_filenames[0] for s in out} == {"inbox/foo.md"}


def test_topic_promotion_requires_minimum_age() -> None:
    notes = [_note("inbox/young.md", category="inbox", created_days_ago=0)]
    snapshot = _snapshot_with({"inbox/young.md": {"read": 100}})
    out = TopicPromotionStrategy(min_age_days=3).propose(notes, {}, snapshot)
    assert out == []


# ── StaleUnseenStrategy ─────────────────────────────────────────────


def test_stale_unseen_finds_old_unseen_notes() -> None:
    notes = [
        _note("topics/old-and-unread.md", created_days_ago=40),
        _note("topics/old-but-read.md", created_days_ago=40),
        _note("topics/recent.md", created_days_ago=2),
    ]
    snapshot = _snapshot_with({"topics/old-but-read.md": {"read": 1}})
    out = StaleUnseenStrategy(min_age_days=14).propose(notes, {}, snapshot)
    assert {s.note_filenames[0] for s in out} == {"topics/old-and-unread.md"}


# ── Persistence ─────────────────────────────────────────────────────


def _make_suggestion(strategy_name: str = "embedding_cluster", *, files: list[str]) -> OrganizationSuggestion:
    import uuid
    return OrganizationSuggestion(
        suggestion_id=uuid.uuid4().hex,
        kind="cluster",
        note_filenames=list(files),
        proposed_label="API",
        proposed_action="group",
        confidence=0.7,
        rationale="testing",
        strategy_name=strategy_name,
    )


def test_add_dedupes_against_active_and_rejected(tmp_path: Path) -> None:
    vault = str(tmp_path)
    s1 = _make_suggestion(files=["a.md", "b.md"])
    s2 = _make_suggestion(files=["b.md", "a.md"])  # same set, different order
    s3 = _make_suggestion(strategy_name="near_duplicate", files=["a.md", "b.md"])
    assert add_suggestions(vault, [s1]) == 1
    # Same strategy + same set → dedup wins.
    assert add_suggestions(vault, [s2]) == 0
    # Different strategy → distinct.
    assert add_suggestions(vault, [s3]) == 1
    # Active list reflects both.
    active = list_active_suggestions(vault)
    assert len(active) == 2


def test_reject_persists_and_blocks_re_add(tmp_path: Path) -> None:
    vault = str(tmp_path)
    s1 = _make_suggestion(files=["a.md", "b.md"])
    add_suggestions(vault, [s1])
    target_id = list_active_suggestions(vault)[0].suggestion_id

    record = update_status(
        vault, target_id, status="rejected", cooldown_days=30
    )
    assert record is not None
    assert record.status == "rejected"
    # Re-proposing the same set must be rejected for dedup.
    assert add_suggestions(vault, [_make_suggestion(files=["a.md", "b.md"])]) == 0
    # Active listing no longer includes it.
    assert list_active_suggestions(vault) == []


def test_load_handles_missing_log_gracefully(tmp_path: Path) -> None:
    assert load_suggestions(str(tmp_path)) == []
    assert list_active_suggestions(str(tmp_path)) == []


def test_load_skips_malformed_lines(tmp_path: Path) -> None:
    log = tmp_path / "_organizer_suggestions.jsonl"
    log.write_text("garbage\n{}\n", encoding="utf-8")
    # Empty obj has no suggestion_id — from_dict will raise; the
    # loader catches and skips. Result: empty list.
    out = load_suggestions(str(tmp_path))
    assert out == []


def test_concurrent_updates_do_not_lose_decisions(tmp_path: Path) -> None:
    """Two concurrent ``update_status`` calls on different suggestions
    must both persist. The previous read-modify-write split (lock only
    around the final write) could lose one of them when both threads
    read the same snapshot before either wrote."""
    import threading

    vault = str(tmp_path)
    s1 = _make_suggestion(files=["a.md"])
    s2 = _make_suggestion(strategy_name="near_duplicate", files=["b.md"])
    add_suggestions(vault, [s1, s2])
    [a, b] = list_active_suggestions(vault)

    barrier = threading.Barrier(2)
    results: list = []

    def _accept(target_id: str, status: str) -> None:
        barrier.wait()  # release both threads at the same instant
        rec = update_status(vault, target_id, status=status)
        results.append(rec)

    t1 = threading.Thread(target=_accept, args=(a.suggestion_id, "accepted"))
    t2 = threading.Thread(target=_accept, args=(b.suggestion_id, "rejected"))
    t1.start(); t2.start()
    t1.join(); t2.join()

    assert all(r is not None for r in results)
    persisted = {s.suggestion_id: s.status for s in load_suggestions(vault)}
    assert persisted[a.suggestion_id] == "accepted"
    assert persisted[b.suggestion_id] == "rejected"
