"""Unit tests for ``service.whiteboard.view_ledger``.

These cover the P0 invariants the design promised:

  * 5 event types are tracked separately (no implicit summing)
  * (agent_id, note_id) keys keep different agents isolated
  * Append-only JSONL + replay produces the same in-memory record
  * ``decorate`` annotates a list of dicts in place with a `_view` block
  * Best-effort: malformed lines and unknown event types are swallowed,
    not raised, so they cannot break a knowledge-tool hot path
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from service.whiteboard.view_ledger import ViewLedger, get_view_ledger
from service.whiteboard.types import VIEW_EVENT_TYPES, ViewKey


@pytest.fixture()
def ledger(tmp_path: Path) -> ViewLedger:
    return ViewLedger(base_path=str(tmp_path), username="alice", agent_id="cocoro")


def test_record_creates_record_with_event_count(ledger: ViewLedger) -> None:
    rec = ledger.record("topics/foo.md", "read")
    assert rec is not None
    assert rec.counts["read"] == 1
    assert rec.last_event == "read"
    assert rec.has_seen() is True


def test_event_counts_are_separate_per_event_type(ledger: ViewLedger) -> None:
    for _ in range(3):
        ledger.record("topics/bar.md", "searched")
    for _ in range(2):
        ledger.record("topics/bar.md", "read")
    rec = ledger.get("topics/bar.md")
    assert rec is not None
    assert rec.counts["searched"] == 3
    assert rec.counts["read"] == 2
    # Untouched event types must remain absent (or zero).
    assert rec.counts.get("listed", 0) == 0
    assert rec.counts.get("injected", 0) == 0


def test_keys_are_isolated_across_agents(tmp_path: Path) -> None:
    cocoro = ViewLedger(base_path=str(tmp_path), username="alice", agent_id="cocoro")
    nova = ViewLedger(base_path=str(tmp_path), username="alice", agent_id="nova")

    cocoro.record("topics/foo.md", "read")
    cocoro.record("topics/foo.md", "read")
    nova.record("topics/foo.md", "read")

    assert cocoro.get("topics/foo.md").counts["read"] == 2  # type: ignore[union-attr]
    assert nova.get("topics/foo.md").counts["read"] == 1  # type: ignore[union-attr]


def test_unknown_event_type_is_swallowed(ledger: ViewLedger) -> None:
    assert ledger.record("topics/foo.md", "telepathised") is None
    assert ledger.get("topics/foo.md") is None


def test_empty_note_id_is_swallowed(ledger: ViewLedger) -> None:
    assert ledger.record("", "read") is None
    assert ledger.record("   ", "read") is None


def test_replay_from_jsonl(tmp_path: Path) -> None:
    ledger = ViewLedger(base_path=str(tmp_path), username="alice", agent_id="cocoro")
    ledger.record("topics/foo.md", "searched")
    ledger.record("topics/foo.md", "read")
    ledger.record("topics/bar.md", "listed")

    # Open a fresh ledger pointed at the same disk path — it must
    # rebuild the index by replaying the JSONL.
    fresh = ViewLedger(base_path=str(tmp_path), username="alice", agent_id="cocoro")
    foo = fresh.get("topics/foo.md")
    bar = fresh.get("topics/bar.md")
    assert foo is not None and bar is not None
    assert foo.counts["searched"] == 1
    assert foo.counts["read"] == 1
    assert bar.counts["listed"] == 1


def test_malformed_jsonl_lines_are_skipped(tmp_path: Path) -> None:
    target_dir = tmp_path / "_view_ledger" / "alice"
    target_dir.mkdir(parents=True)
    jsonl = target_dir / "cocoro.jsonl"
    # Three bad lines + one good one; only the good one should land.
    jsonl.write_text(
        "\n".join(
            [
                "this is not json",
                json.dumps({"event_type": "unknown"}),
                json.dumps({}),
                json.dumps(
                    {
                        "ts": "2026-05-07T09:10:34+00:00",
                        "event_type": "read",
                        "note_id": "topics/foo.md",
                    }
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    ledger = ViewLedger(base_path=str(tmp_path), username="alice", agent_id="cocoro")
    rec = ledger.get("topics/foo.md")
    assert rec is not None
    assert rec.counts["read"] == 1


def test_view_meta_for_unseen_returns_seen_false(ledger: ViewLedger) -> None:
    meta = ledger.view_meta("topics/missing.md")
    assert meta == {
        "seen": False,
        "counts": {},
        "first_seen_at": None,
        "last_seen_at": None,
        "last_event": None,
    }


def test_decorate_adds_view_meta_in_place(ledger: ViewLedger) -> None:
    ledger.record("topics/foo.md", "read")
    ledger.record("topics/foo.md", "searched")

    items = [
        {"filename": "topics/foo.md", "title": "Foo"},
        {"filename": "topics/missing.md", "title": "Missing"},
        {"title": "no filename"},
    ]
    out = ledger.decorate(items)
    assert out is items  # in-place mutation
    foo_meta = items[0]["_view"]
    assert foo_meta["seen"] is True
    assert foo_meta["counts"]["read"] == 1
    assert foo_meta["counts"]["searched"] == 1
    missing_meta = items[1]["_view"]
    assert missing_meta["seen"] is False
    no_fn_meta = items[2]["_view"]
    assert no_fn_meta["seen"] is False


def test_record_many_records_one_event_per_id(ledger: ViewLedger) -> None:
    n = ledger.record_many(["a.md", "b.md", "c.md"], "listed")
    assert n == 3
    assert ledger.get("a.md").counts["listed"] == 1  # type: ignore[union-attr]
    assert ledger.get("b.md").counts["listed"] == 1  # type: ignore[union-attr]
    assert ledger.get("c.md").counts["listed"] == 1  # type: ignore[union-attr]


def test_stats_reports_per_event_totals(ledger: ViewLedger) -> None:
    ledger.record("topics/foo.md", "read")
    ledger.record("topics/foo.md", "read")
    ledger.record("topics/foo.md", "searched")
    ledger.record("topics/bar.md", "injected")

    stats = ledger.stats()
    assert stats["agent_id"] == "cocoro"
    assert stats["total_notes_seen"] == 2
    events = stats["events"]
    # All five canonical events must be present, even if zero.
    for ev in VIEW_EVENT_TYPES:
        assert ev in events
    assert events["read"] == 2
    assert events["searched"] == 1
    assert events["injected"] == 1
    assert events["listed"] == 0
    assert events["mentioned"] == 0


def test_get_view_ledger_with_custom_base_returns_fresh_instance(tmp_path: Path) -> None:
    """The factory must hand back fresh instances for tests that supply
    a custom ``base_path`` so cached state from other tests can't leak in.
    """
    a = get_view_ledger("alice", "cocoro", base_path=str(tmp_path))
    b = get_view_ledger("alice", "cocoro", base_path=str(tmp_path))
    # Same disk path, but each call returns a fresh instance — tests
    # are isolated even when they share a username/agent_id pair.
    assert a is not b


def test_first_seen_at_is_preserved_across_subsequent_records(ledger: ViewLedger) -> None:
    early = datetime(2026, 5, 1, 9, 0, tzinfo=timezone.utc)
    late = early + timedelta(hours=4)

    ledger.record("topics/foo.md", "searched", ts=early)
    ledger.record("topics/foo.md", "read", ts=late)

    rec = ledger.get("topics/foo.md")
    assert rec is not None
    assert rec.first_seen_at == early
    assert rec.last_seen_at == late


def test_view_key_is_hashable_for_use_as_dict_key() -> None:
    key = ViewKey(agent_id="a", note_id="n")
    bag = {key: 1}
    assert bag[ViewKey(agent_id="a", note_id="n")] == 1
