"""MemoryUsageTracker — the self-reinforcement-safe learning collector.

These are pure-logic tests (no Synapse engine): a fake handle records the
positive/negative splits the tracker would feed to SynapseMemory.learn, so we
assert exactly WHEN learning fires and with WHICH notes.
"""

from __future__ import annotations

import numpy as np

from service.memory.usage_tracker import (
    MemoryUsageTracker,
    RETENTION_MIN_TURNS,
    SIGNAL_EDIT,
    ref_key,
)


class FakeHandle:
    def __init__(self):
        self.calls = []

    def feedback(self, query_key, *, positives, negatives, label_src="implicit"):
        self.calls.append({"query": query_key,
                           "pos": [k for k, _ in positives],
                           "neg": len(negatives), "label": label_src})
        return {"applied": 1.0}


def _hits(*keys):
    return [(k, np.ones(4, dtype=np.float32)) for k in keys]


def test_no_signal_no_learning():
    """The core guarantee: retrieval alone never trains. A query with zero
    external signals must produce zero feedback calls."""
    tr = MemoryUsageTracker()
    tr.record_search("q", _hits("a", "b", "c"))
    h = FakeHandle()
    out = tr.flush(h)
    assert out == {"learned": 0.0}
    assert h.calls == []


def test_signal_pairs_positive_vs_same_query_negatives():
    tr = MemoryUsageTracker()
    tr.record_search("q", _hits("a", "b", "c"))
    tr.mark_useful("a", SIGNAL_EDIT)
    h = FakeHandle()
    tr.flush(h)
    assert len(h.calls) == 1
    c = h.calls[0]
    assert c["query"] == "q" and c["pos"] == ["a"] and c["neg"] == 2
    assert c["label"] == SIGNAL_EDIT


def test_flagged_note_with_no_contrast_is_skipped():
    """If every shown note for a query is flagged, there is no negative to
    contrast against — skip rather than invent one."""
    tr = MemoryUsageTracker()
    tr.record_search("q", _hits("a"))
    tr.mark_useful("a", SIGNAL_EDIT)
    h = FakeHandle()
    tr.flush(h)
    assert h.calls == []


def test_signal_for_unseen_note_trains_nothing():
    tr = MemoryUsageTracker()
    tr.record_search("q", _hits("a", "b"))
    tr.mark_useful("z", SIGNAL_EDIT)  # never shown
    h = FakeHandle()
    tr.flush(h)
    assert h.calls == []


def test_retention_needs_min_distinct_turns():
    tr = MemoryUsageTracker()
    tr.record_search("q", _hits("a", "b"))
    # same turn repeated — must NOT accumulate
    for _ in range(RETENTION_MIN_TURNS + 2):
        tr.note_injected("a")
    h = FakeHandle()
    tr.flush(h)
    assert h.calls == [], "retention must count DISTINCT turns, not repeats"

    tr2 = MemoryUsageTracker()
    tr2.record_search("q", _hits("a", "b"))
    for _ in range(RETENTION_MIN_TURNS):
        tr2.begin_turn()
        tr2.note_injected("a")
    h2 = FakeHandle()
    tr2.flush(h2)
    assert len(h2.calls) == 1 and h2.calls[0]["pos"] == ["a"]


def test_citation_scan_flags_by_title():
    tr = MemoryUsageTracker()
    tr.record_search("q", _hits("k1", "k2"))
    tr.register_title("k1", "리듬게임 판정 노트")
    tr.register_title("k2", "짧")  # below CITATION_MIN_TITLE → never matches
    n = tr.scan_citations("답변: 리듬게임 판정 노트를 참고했습니다. 짧")
    assert n == 1
    h = FakeHandle()
    tr.flush(h)
    assert len(h.calls) == 1 and h.calls[0]["pos"] == ["k1"]


def test_flush_consumes_signals_but_keeps_provenance():
    tr = MemoryUsageTracker()
    tr.record_search("q", _hits("a", "b"))
    tr.mark_useful("a", SIGNAL_EDIT)
    h = FakeHandle()
    tr.flush(h)
    # signal consumed → a second flush with no NEW signal trains nothing …
    tr.flush(h)
    assert len(h.calls) == 1
    # … but provenance survived, so a later-turn signal still pairs correctly.
    tr.mark_useful("b", SIGNAL_EDIT)
    tr.flush(h)
    assert len(h.calls) == 2 and h.calls[1]["pos"] == ["b"]


def test_ref_key_accepts_dict_and_obj():
    class R:
        scope = "Scope.SESSION"; category = "topics"; filename = "n.md"
    assert ref_key(R()) == "Scope.SESSION/topics/n.md"
    assert ref_key({"scope": "Scope.SESSION", "category": "topics",
                    "filename": "n.md"}) == "Scope.SESSION/topics/n.md"
    assert ref_key(None) == ""
