"""Memory usage tracker — turns trusted "this memory was useful" signals into
Synapse learning updates, WITHOUT ever treating retrieval itself as a reward.

The executor has no feedback seam: its ``VectorHandle`` contract is
search-only, and the ``query_token``/feature provenance of a retrieval is
dropped before any event fires (only ``chunk.key`` survives). So the learning
loop must be closed on the Geny side. This tracker is the closure.

Design
------
* ``record_search`` is called *inside* ``SynapseVectorHandle.search`` — the one
  place that still holds both the query and each hit's raw feature vector. It
  remembers, per query, the shown note keys and their feature vectors.
* ``mark_useful`` is called when Geny observes a genuine external signal that a
  specific note mattered: the agent EDITED it, the final answer CITED it, it was
  PROMOTED to long-term, or it survived as injected context across several turns
  (RETENTION, deliberately conservative). Retrieval alone is never a signal.
* ``flush`` (end of turn) pairs, per remembered query, the flagged notes
  (positives) against the same query's shown-but-unflagged notes (negatives) and
  calls ``handle.feedback`` → ``SynapseMemory.learn``. A query with no external
  signal trains nothing — this is what stops the ranker from rubber-stamping
  whatever the current retriever already surfaces (self-reinforcement).

Because features are remembered here (not looked up in the engine's bounded
recent-query cache), a note edited/cited many turns after it was retrieved still
reinforces correctly — the cross-turn property ``SynapseMemory.learn`` was built
for.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

#: Signals that count as "useful". Retrieval is intentionally NOT one of them.
SIGNAL_EDIT = "edit"          # agent re-wrote/updated the note  (strong)
SIGNAL_CITE = "cite"          # final answer referenced the note (strong)
SIGNAL_PROMOTE = "promote"    # note promoted STM→LTM/critical   (strong)
SIGNAL_RETENTION = "retention"  # injected across ≥N turns       (weak, gated)

#: A note must be injected into context across at least this many DISTINCT turns
#: before retention counts — high enough that transient re-retrieval (which
#: would be mild self-reinforcement) does not trip it.
RETENTION_MIN_TURNS = 3


class MemoryUsageTracker:
    """Per-session collector: search provenance in, trusted signals in,
    Synapse learning out. Cheap, bounded, thread-naive (called from the session
    task only)."""

    #: A note title must be at least this many chars before a substring match in
    #: the answer counts as a citation — short/common titles would false-fire.
    CITATION_MIN_TITLE = 5

    def __init__(self, *, max_queries: int = 256) -> None:
        # query_key -> {"features": {note_key: ndarray}, "shown": [note_key]}
        self._searches: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._max_queries = max_queries
        # note_key -> title, for citation scanning of the final answer
        self._titles: Dict[str, str] = {}
        # note_key -> set of signals observed since last flush
        self._signals: Dict[str, Set[str]] = {}
        # note_key -> set of distinct turn indices it was injected as context
        self._retention: Dict[str, Set[int]] = {}
        self._turn = 0
        # cumulative, for observability
        self.stats: Dict[str, float] = {"searches": 0, "flushes": 0,
                                        "learn_calls": 0, "positives": 0}

    # ── ingestion ────────────────────────────────────────────────────
    def record_search(self, query_key: str,
                      hits: List[Tuple[str, Any]],
                      titles: Optional[Dict[str, str]] = None) -> None:
        """Remember a query's shown notes + feature vectors.

        *hits* is ``[(note_key, feature_ndarray), ...]`` in shown order. Called
        from the vector handle where both are still live. *titles* maps note_key
        → title for later citation scanning of the final answer.
        """
        if not query_key or not hits:
            return
        if titles:
            self._titles.update({k: v for k, v in titles.items() if v})
        feats = {k: f for k, f in hits if f is not None}
        if not feats:
            return
        entry = self._searches.get(query_key)
        if entry is None:
            entry = {"features": {}, "shown": []}
            self._searches[query_key] = entry
        # Merge (a query text can repeat across turns); newest features win, and
        # shown order/dedup is preserved.
        for k, f in feats.items():
            if k not in entry["features"]:
                entry["shown"].append(k)
            entry["features"][k] = f
        self._searches.move_to_end(query_key)
        while len(self._searches) > self._max_queries:
            self._searches.popitem(last=False)
        self.stats["searches"] += 1

    def mark_useful(self, note_key: str, signal: str) -> None:
        """Record that a genuine external signal implicates *note_key*."""
        if not note_key:
            return
        self._signals.setdefault(note_key, set()).add(signal)

    def register_title(self, note_key: str, title: str) -> None:
        """Register a note's display title for citation scanning. The vector
        engine doesn't store titles (the executor's auto-index hands it only the
        body), so titles come from the note-write hooks (NoteMeta.title)."""
        if note_key and title:
            self._titles[note_key] = title

    def note_injected(self, note_key: str) -> None:
        """Register that *note_key* was injected into context this turn; enough
        distinct turns of this promotes it to a (weak) RETENTION signal."""
        if not note_key:
            return
        turns = self._retention.setdefault(note_key, set())
        turns.add(self._turn)
        if len(turns) >= RETENTION_MIN_TURNS:
            self.mark_useful(note_key, SIGNAL_RETENTION)

    def scan_citations(self, answer_text: str) -> int:
        """Flag any tracked note whose title is quoted verbatim in the final
        answer — a strong "this memory was used" signal. Returns the count."""
        if not answer_text:
            return 0
        n = 0
        for key, title in self._titles.items():
            t = (title or "").strip()
            if len(t) >= self.CITATION_MIN_TITLE and t in answer_text:
                self.mark_useful(key, SIGNAL_CITE)
                n += 1
        return n

    def begin_turn(self) -> None:
        self._turn += 1

    # ── flush → learning ─────────────────────────────────────────────
    def flush(self, handle: Any) -> Dict[str, float]:
        """Pair flagged notes (positive) vs same-query shown-unflagged notes
        (negative) and drive Synapse learning. Only queries that produced at
        least one externally-flagged note train anything.

        Returns a small metrics dict; never raises (learning is best-effort).
        """
        flagged = set(self._signals)
        if not flagged:
            return {"learned": 0.0}
        learned = 0
        positives_total = 0
        for query_key, entry in list(self._searches.items()):
            feats = entry["features"]
            shown = entry["shown"]
            pos_keys = [k for k in shown if k in flagged and k in feats]
            if not pos_keys:
                continue
            neg = [feats[k] for k in shown if k not in flagged and k in feats]
            if not neg:
                # No contrast available for this query — skip rather than invent
                # a negative (which could push down an unrelated good note).
                continue
            positives = [(k, feats[k]) for k in pos_keys]
            # Label source = the strongest signal seen (for observability only).
            label = _dominant_label({s for k in pos_keys
                                     for s in self._signals.get(k, ())})
            try:
                handle.feedback(query_key, positives=positives, negatives=neg,
                                label_src=label)
                learned += 1
                positives_total += len(positives)
            except Exception:  # noqa: BLE001 — learning must never break a turn
                logger.debug("synapse feedback failed", exc_info=True)
        self.stats["flushes"] += 1
        self.stats["learn_calls"] += learned
        self.stats["positives"] += positives_total
        # Consume signals; keep search provenance (a later turn may flag more).
        self._signals.clear()
        return {"learned": float(learned), "positives": float(positives_total)}

    def snapshot(self) -> Dict[str, float]:
        return dict(self.stats)


def _dominant_label(signals: Set[str]) -> str:
    for s in (SIGNAL_EDIT, SIGNAL_CITE, SIGNAL_PROMOTE, SIGNAL_RETENTION):
        if s in signals:
            return s
    return "implicit"


def ref_key(ref: Any) -> str:
    """The note's tracker key — MUST match ``synapse_handle._node_id`` so signal
    keys line up with search-recorded keys. Accepts a NoteRef-like object OR a
    dict (the ``memory.promoted`` event ships ``ref`` as a dict)."""
    if ref is None:
        return ""

    def g(name: str) -> Any:
        if isinstance(ref, dict):
            return ref.get(name)
        return getattr(ref, name, None)

    parts = [g("scope"), g("category"), g("filename")]
    return "/".join(str(p) for p in parts if p)
