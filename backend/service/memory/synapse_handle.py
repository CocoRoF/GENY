"""Synapse vector handle — wraps geny-memory-adaptor's SynapseMemory as a
geny-executor ``VectorHandle`` so the file memory provider's semantic layer
runs on the local, learnable, zero-API-call Synapse engine.

The file provider keeps STM/LTM/Notes as markdown; only the vector layer is
replaced. Notes are indexed into Synapse on write (``attach_vector_indexer``
→ ``index(ref, body)``), semantic retrieval routes through ``search()`` (the
Stage-2 retriever's L3 layer calls ``provider.vector().search(...)``), and each
hit's ``content`` is filled from Synapse's own stored body (``get_text``), so
there is no second copy of the corpus and no embedding API call.

Structural match for ``geny_executor.memory.provider.VectorHandle`` — plus the
``vector_disabled`` / ``disabled_reason`` attributes the file provider reads off
the concrete store.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from geny_memory_adaptor import FEATURES

try:  # adaptor >= 1.8
    from geny_memory_adaptor import MemoryBusy
except ImportError:  # pragma: no cover — older adaptor never raises it
    class MemoryBusy(RuntimeError):  # type: ignore[no-redef]
        pass

from service.memory import inflight

from geny_executor.memory.provider import (
    EmbeddingDescriptor,
    NoteRef,
    ReindexPlan,
)
from geny_executor.stages.s02_context.types import MemoryChunk

logger = logging.getLogger(__name__)


def _node_id(ref: NoteRef) -> str:
    """Stable id for a note across scope/category — the vector store's key."""
    parts = [getattr(ref, "scope", None), getattr(ref, "category", None),
             ref.filename]
    return "/".join(str(p) for p in parts if p)


def _feature_vector(hit) -> Optional[np.ndarray]:
    """SearchHit.features (a name→value dict) → the ordered raw feature vector
    the ranker learns on. Returns None if the hit carries no features."""
    f = getattr(hit, "features", None)
    if not f:
        return None
    return np.array([f.get(name, 0.0) for name in FEATURES], dtype=np.float32)


# ── note metadata → index fields ─────────────────────────────────────
#
# The index ranks on 14 features. Five of them read metadata the write
# path never sent, so in production they were dead constants: measured
# 2026-08-18 across three live vaults, EVERY node had importance=1.0,
# pinned=0, and empty tags and title — 0 tag edges, and `title_hit` and
# `ppr_tag` structurally always zero. The notes themselves carry all of
# it (1497 of 1500 sampled had title/tags/importance in frontmatter); it
# was simply dropped at the handle.

#: The vault speaks importance as a LABEL; the index ranks on a WEIGHT.
#: Keeping the translation in one named place is the point — reading a
#: weight as a label is what took the graph tab down on 2026-08-18.
_IMPORTANCE_WEIGHT = {
    "critical": 2.0,
    "high": 1.5,
    "medium": 1.0,
    "low": 0.5,
}

#: How a note says "keep me": `pin_policy` writes these markers when it
#: promotes an insight into `critical/`.
_PIN_TAGS = frozenset({"pinned", "auto-pinned"})


def _importance_weight(raw: Any) -> float:
    """Label → ranking weight. Unknown labels rank neutral, never zero:
    an unrecognised word must not bury a note."""
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    label = str(getattr(raw, "value", raw) or "").strip().lower()
    return _IMPORTANCE_WEIGHT.get(label, 1.0)


def _accepted_kwargs(fn: Any) -> frozenset:
    """Which keyword names *fn* will take — ``**kwargs`` means all of them.

    Used only on the version-skew fallback: an engine old enough to lack
    batch indexing may also predate some of these fields, and that branch
    exists to keep memory working through exactly that kind of skew.
    """
    import inspect

    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):  # pragma: no cover — builtins/C funcs
        return frozenset()
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return frozenset({"kind", "title", "tags", "importance", "pinned",
                          "updated_at"})
    return frozenset(params)


def _index_meta(note: Any) -> Dict[str, Any]:
    """The fields a note can contribute to its index row.

    Deliberately NOT including wikilinks. In this vault all 284 of them
    are image embeds (`![[frame.jpg]]`) rather than note-to-note links,
    so indexing them would manufacture LINK edges pointing at nodes that
    do not exist. Revisit when notes actually cross-link — and then
    resolve targets to node ids on BOTH write paths at once, or the two
    will disagree on the content digest and re-index each other forever.
    """
    tags = [str(t) for t in (getattr(note, "tags", None) or []) if str(t).strip()]
    return {
        "title": str(getattr(note, "title", "") or ""),
        "tags": tags,
        "importance": _importance_weight(getattr(note, "importance", None)),
        "pinned": bool(_PIN_TAGS & set(tags)),
    }


class SynapseVectorHandle:
    """Duck-typed ``VectorHandle`` backed by a local Synapse engine.

    Beyond the executor's search-only contract, this handle also closes the
    LEARNING loop: ``search`` records each query's shown notes + feature vectors
    into a per-session usage tracker, and ``feedback`` forwards a trusted
    positive/negative split to ``SynapseMemory.learn``. Retrieval itself is never
    treated as a reward — only Geny-observed external signals are (see
    ``usage_tracker``)."""

    #: Read by FileMemoryProvider._build_descriptor / capability gating.
    vector_disabled = False
    disabled_reason = ""

    def __init__(self, memory, *, dim: int, usage_tracker: Any = None) -> None:
        # `memory` is a geny_memory_adaptor.SynapseMemory (lazy-typed to avoid a
        # hard import when the extra isn't installed).
        self._m = memory
        self._dim = dim
        #: Set by provider_bridge; search feeds it, the session flushes it.
        self.usage_tracker = usage_tracker

    @property
    def descriptor(self) -> EmbeddingDescriptor:
        return EmbeddingDescriptor(
            provider="synapse",
            model="synapse-hash-static",
            dimension=self._dim,
            metric="cosine",
            api_key_present=False,
        )

    # Synapse's SQLite/graph ops are sync. They're "CPU-ms" for a small vault,
    # but a large session's initial re-index (thousands of notes) or a distill
    # is write-heavy and, on a slow disk, can take many seconds — long enough to
    # freeze the whole asyncio event loop (a session load once wedged the server
    # for hours in ``rq_qos_wait``). SynapseMemory is thread-safe
    # (``check_same_thread=False`` + an internal ``RLock``), so every sync call
    # here is dispatched through ``asyncio.to_thread`` — the loop keeps serving
    # other sessions/health while one session's memory work runs on a worker.

    async def index(self, ref: NoteRef, text: str, note: Any = None) -> int:
        # `note` is optional and additive: the batch path and this one must
        # derive the SAME row for the same note, because the engine's
        # idempotence digest covers title/tags/importance/pinned. If one
        # path sent them and the other did not, every note would flip
        # between two digests and re-index itself forever.
        meta = _index_meta(note) if note is not None else {}

        def _run() -> None:
            with inflight.track("index"):
                self._m.index(_node_id(ref), text,
                              kind=str(getattr(ref, "category", None) or "note"),
                              **meta)
        await asyncio.to_thread(_run)
        return 1

    async def index_batch(self, items: Sequence[Tuple[NoteRef, str]]) -> int:
        # Items are (ref, text) or (ref, text, updated_at). The third form
        # carries the NOTE's own timestamp: without it every row records
        # when the INDEX wrote, so after a full re-index the whole vault
        # claims to have changed on the same day and grouping by date says
        # nothing. It also costs nothing — a same-content/new-clock item is
        # a batched touch, not a re-index.
        payload = []
        for item in items:
            ref, text = item[0], item[1]
            row = {
                "node_id": _node_id(ref),
                "text": text,
                "kind": str(getattr(ref, "category", None) or "note"),
            }
            if len(item) > 2 and item[2]:
                row["updated_at"] = float(item[2])
            # Fourth form: the NOTE itself, so title/tags/importance/pinned
            # reach the index instead of being dropped here (see
            # `_index_meta`). Optional so a caller that only has bytes —
            # and every non-Synapse VectorHandle — is unaffected.
            if len(item) > 3 and item[3] is not None:
                row.update(_index_meta(item[3]))
            payload.append(row)

        def _run() -> int:
            with inflight.track("index_batch"):
                # ONE transaction per chunk, not per note. A per-note commit
                # costs an fsync (43.7 ms on this deployment) against 2-3 ms
                # of real indexing, so a catch-up used to be almost entirely
                # disk sync: 500 changed notes measured 511 s one at a time
                # and 42 s batched.
                batch = getattr(self._m, "index_many", None)
                if batch is None:
                    # Older adaptor. Slow, but a version skew must not take
                    # memory out entirely — this is the whole vault's write
                    # path, not an optional feature.
                    # Send the metadata only if this older engine can take
                    # it. The point of this branch is that a version skew
                    # must not take memory out entirely, so it must not
                    # itself become a way to break on an old signature.
                    accepted = _accepted_kwargs(self._m.index)
                    for item in payload:
                        extra = {k: v for k, v in item.items()
                                 if k in accepted
                                 and k not in ("node_id", "text")}
                        self._m.index(item["node_id"], item["text"], **extra)
                    return len(payload)
                out = batch(payload, chunk_size=200)
            return int(out.get("indexed", 0))

        # One hop to the worker for the whole batch (not per item) — the initial
        # session re-index is exactly this path.
        return await asyncio.to_thread(_run)

    # ── write-contract versioning ────────────────────────────────────
    #
    #: Bump when this handle starts sending the engine something NEW that
    #: the idempotence digest covers. Existing rows are only re-offered
    #: when their note's timestamp moves or their digest is blank, so a
    #: richer write path would otherwise reach only notes edited after the
    #: deploy — leaving the vault permanently half-indexed, with new notes
    #: ranked on live features and old ones on dead constants.
    #:
    #: 1: title / tags / importance / pinned started being sent
    #:    (2026-08-18). Before this every node in production had
    #:    importance=1.0, pinned=0 and empty tags/title.
    _WRITE_CONTRACT = 1
    _CONTRACT_PARAM = "geny_write_contract"

    async def ensure_write_contract(self) -> int:
        """Blank every digest once when the write contract has moved.

        Returns how many rows were invalidated (0 when already current).
        The reconcile treats a blank digest as stale, so the next warm-up
        re-offers the vault and it lands with the full metadata.
        """
        def _run() -> int:
            store = getattr(self._m, "store", None)
            if store is None:  # pragma: no cover — older adaptor
                return 0
            try:
                raw = store.get_param(self._CONTRACT_PARAM)
                seen = int(raw.decode()) if raw else 0
            except Exception:  # noqa: BLE001 — unreadable marker = "old"
                seen = 0
            if seen >= self._WRITE_CONTRACT:
                return 0
            with inflight.track("write_contract_upgrade"):
                n = int(store.clear_content_shas())
                store.put_param(self._CONTRACT_PARAM,
                                str(self._WRITE_CONTRACT).encode())
            return n

        return await asyncio.to_thread(_run)

    # ── incremental host support ─────────────────────────────────────
    # The three calls below are what let a caller ask "what changed?" instead
    # of re-offering the whole vault. Without them the only way to find one
    # edited note is to re-read 5,500 of them and re-derive every digest.

    def node_id_for(self, ref: NoteRef) -> str:
        """The index's key for a note. Public so a caller can diff against
        ``manifest()`` without duplicating the id convention — two places
        building the same id differently is how an index silently doubles."""
        return _node_id(ref)

    async def manifest(self) -> Dict[str, Tuple[float, str]]:
        """``{node_id: (indexed_at, content_sha)}`` — what is already indexed."""
        def _run() -> Dict[str, Tuple[float, str]]:
            with inflight.track("manifest"):
                return self._m.manifest()
        return await asyncio.to_thread(_run)

    async def catalog_counts(self, *, by: str = "kind",
                             kind: Optional[str] = None) -> List[Tuple[str, int]]:
        """``[(key, count)]`` by kind or by day — metadata only, no bodies."""
        def _run():
            with inflight.track("catalog_counts"):
                return self._m.catalog_counts(by=by, kind=kind)
        return await asyncio.to_thread(_run)

    async def catalog_page(self, *, day: Optional[str] = None,
                           kind: Optional[str] = None, limit: int = 100,
                           offset: int = 0) -> List[Dict[str, Any]]:
        """One page of note metadata, filtered and paged in SQL."""
        def _run():
            with inflight.track("catalog_page"):
                return self._m.catalog_page(day=day, kind=kind, limit=limit,
                                            offset=offset)
        return await asyncio.to_thread(_run)

    async def neighbourhood(self, node_ids: Sequence[str], *, depth: int = 1,
                            max_nodes: int = 400,
                            max_edges: int = 4000) -> Dict[str, Any]:
        """The bounded subgraph around a selection."""
        ids = list(node_ids)

        def _run():
            with inflight.track("neighbourhood"):
                return self._m.neighbourhood(ids, depth=depth,
                                             max_nodes=max_nodes,
                                             max_edges=max_edges)
        return await asyncio.to_thread(_run)

    async def remove_many(self, node_ids: Sequence[str]) -> int:
        """Drop nodes by index key, one transaction.

        Takes ids rather than refs because the caller that needs this is
        reaping notes whose files are GONE — there is no ref left to build.
        """
        ids = list(node_ids)
        if not ids:
            return 0

        def _run() -> int:
            with inflight.track("remove_many"):
                return int(self._m.remove_many(ids))
        return await asyncio.to_thread(_run)

    async def search(self, text: str, *, top_k: int = 5,
                     threshold: float = 0.0) -> List[MemoryChunk]:
        # Search + per-hit body fetch both hit SQLite → run the whole read on a
        # worker thread and hand back plain data.
        def _run() -> Tuple[list, list]:
            with inflight.track("search"):
                try:
                    hits = self._m.search(text, top_k=top_k)
                except MemoryBusy as exc:
                    # A turn can answer without memory; it cannot answer while
                    # blocked behind a write that never returns. Degrading here
                    # is the difference between a shallow reply and the 27-hour
                    # silence a single wedged write produced.
                    logger.warning("memory search skipped — %s", exc)
                    return [], []
                bodies = [self._m.get_text(h.id) for h in hits
                          if h.score >= threshold]
            return hits, bodies
        hits, bodies = await asyncio.to_thread(_run)
        # Record provenance for learning BEFORE thresholding — a note that just
        # missed the score cut is still a valid negative for this query. Pure
        # in-memory bookkeeping, cheap on the loop.
        tracker = self.usage_tracker
        if tracker is not None and hits:
            try:
                # Query TEXT is the learning key (stable across turns → keeps a
                # query on one side of the blend gate's hold-out), not the
                # per-call query_token (which varies every search).
                tracker.record_search(
                    text, [(h.id, _feature_vector(h)) for h in hits],
                    titles={h.id: h.title for h in hits if h.title})
            except Exception:  # noqa: BLE001 — never break retrieval
                logger.debug("usage_tracker.record_search failed", exc_info=True)
        out: List[MemoryChunk] = []
        bi = 0
        for h in hits:
            if h.score < threshold:
                continue
            body = bodies[bi] or h.title or ""
            bi += 1
            out.append(MemoryChunk(
                key=h.id,
                content=body,
                source="vector",
                relevance_score=float(h.score),
                metadata={"engine": "synapse", "sources": h.sources,
                          "query_token": h.query_token, "kind": h.kind},
            ))
        return out

    def feedback(self, query_key: str, *,
                 positives: Sequence[Tuple[str, Any]],
                 negatives: Sequence[Any],
                 label_src: str = "implicit") -> dict:
        """Forward a trusted usefulness signal to Synapse's cross-turn learner.

        *positives* is ``[(note_id, feature_vector), ...]`` for notes an external
        signal confirmed useful; *negatives* is the feature vectors of the same
        query's shown-but-unflagged notes. Synchronous CPU-ms; the caller (the
        session's end-of-turn flush) runs it off the hot path.

        As of adaptor 1.5.0 positives also bump the per-item TRUST prior
        (asymmetric, decaying to neutral — the anti-ossification axis).
        Negative trust is deliberately NOT auto-wired: "shown but unused" can
        blame a note for a bad query; explicit unhelpful feedback goes through
        :meth:`trust_unhelpful` when a trustworthy negative signal exists."""
        return self._m.learn(query_key, positives=positives,
                             negatives=negatives, label_src=label_src)

    def trust_unhelpful(self, note_key: str) -> Optional[float]:
        """Explicit 'this memory was wrong/unhelpful' — loss-averse trust drop
        (2× the helpful bump). Returns the new trust or None if unknown."""
        return self._m.trust_feedback(note_key, False)

    def contradictions(self, note_key: str, *, top_k: int = 5) -> list:
        """Memories likely conflicting with *note_key* (store hygiene,
        deterministic — negation-marker asymmetry × topical overlap).
        Diagnostic only; surfaced by the host as observability, never
        injected into prompts."""
        return self._m.contradictions(note_key, top_k=top_k)

    async def remove(self, ref: NoteRef) -> bool:
        def _run() -> None:
            with inflight.track("remove"):
                self._m.remove(_node_id(ref))
        await asyncio.to_thread(_run)
        return True

    async def reindex(self, *, plan: Optional[ReindexPlan] = None) -> ReindexPlan:
        # Synapse indexes are incremental + derived; distillation is the only
        # batch maintenance and needs no external tokens/cost. Write-heavy over
        # the whole graph → off the loop.
        def _distill():
            with inflight.track("distill"):
                return self._m.distill()
        metrics = await asyncio.to_thread(_distill)
        return ReindexPlan(
            layer="vector",
            reason="synapse distill (local, zero-cost)",
            chunks_to_reindex=int(metrics.get("pairs", 0)),
            estimated_tokens=0,
            estimated_cost_usd=0.0,
            requires_explicit_approval=False,
        )

    async def fetch_document(self, ref: NoteRef, *,
                             max_chunks: int = 5000) -> List[MemoryChunk]:
        # Synapse stores one vector per note (no sub-chunking), so a document is
        # its single chunk.
        nid = _node_id(ref)
        def _get_text():
            with inflight.track("get_text"):
                return self._m.get_text(nid)
        body = await asyncio.to_thread(_get_text)
        if body is None:
            return []
        return [MemoryChunk(key=nid, content=body, source="vector",
                            relevance_score=1.0, metadata={"engine": "synapse"})]

    def close(self) -> None:
        try:
            self._m.close()
        except Exception:  # noqa: BLE001
            logger.debug("synapse close failed", exc_info=True)
