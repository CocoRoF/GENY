"""The index must be told what the note actually is.

Audited 2026-08-18 against three production vaults. Every node in all of
them had ``importance=1.0``, ``pinned=0``, empty ``tags`` and empty
``title`` — 0 tag edges and 0 link edges, every edge machine-derived.

The engine ranks on fourteen features. Five of them read exactly that
metadata (``importance``, ``pinned``, ``title_hit``, ``ppr_tag``,
``ppr_link``), so five signals were dead constants. The notes carried the
data all along: 1497 of 1500 sampled notes had title, tags and importance
in their frontmatter. It was dropped at the vector handle, which sent the
engine only ``node_id``, ``text``, ``kind`` and ``updated_at``.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from service.memory import synapse_handle as sh


class _Ref:
    def __init__(self, filename="n.md", category="daily", scope="session"):
        self.filename = filename
        self.category = category
        self.scope = scope


def _note(**kw):
    base = dict(title="제목", tags=["work", "geny"], importance="high")
    base.update(kw)
    return SimpleNamespace(**base)


# ── the label → weight translation ───────────────────────────────────

def test_importance_labels_become_weights():
    """The vault speaks labels; the index ranks on a weight. Confusing the
    two is what took the graph tab down — keep the translation explicit."""
    assert sh._importance_weight("critical") > sh._importance_weight("high")
    assert sh._importance_weight("high") > sh._importance_weight("medium")
    assert sh._importance_weight("medium") > sh._importance_weight("low")
    assert sh._importance_weight("MEDIUM") == sh._importance_weight("medium")


def test_an_enum_like_importance_is_read_through_value():
    assert sh._importance_weight(SimpleNamespace(value="critical")) == 2.0


def test_an_unknown_label_ranks_neutral_not_zero():
    """An unrecognised word must not bury a note."""
    assert sh._importance_weight("어쩌구") == 1.0
    assert sh._importance_weight(None) == 1.0
    assert sh._importance_weight("") == 1.0


def test_a_numeric_importance_passes_through():
    """Already a weight — do not translate it twice."""
    assert sh._importance_weight(2.5) == 2.5


# ── what a note contributes ──────────────────────────────────────────

def test_note_metadata_reaches_the_row():
    meta = sh._index_meta(_note())
    assert meta["title"] == "제목"
    assert meta["tags"] == ["work", "geny"]
    assert meta["importance"] == 1.5
    assert meta["pinned"] is False


def test_pin_markers_set_pinned():
    """`pin_policy` writes these tags when it promotes to critical/."""
    assert sh._index_meta(_note(tags=["pinned"]))["pinned"] is True
    assert sh._index_meta(_note(tags=["auto-pinned"]))["pinned"] is True
    assert sh._index_meta(_note(tags=["work"]))["pinned"] is False


def test_blank_and_odd_tags_are_dropped():
    meta = sh._index_meta(_note(tags=["  ", "", "ok", 3]))
    assert meta["tags"] == ["ok", "3"]


def test_links_are_deliberately_not_indexed():
    """All 284 wikilinks in the production vault are image embeds, so
    indexing them would point LINK edges at nodes that do not exist."""
    meta = sh._index_meta(_note(links_out=["some-note", "frame.jpg"]))
    assert "links" not in meta


# ── the digest-consistency trap ──────────────────────────────────────

@pytest.mark.asyncio
async def test_both_write_paths_derive_the_same_row():
    """The engine's idempotence digest covers title/tags/importance/pinned.
    If the single-note path sent them and the batch path did not (or vice
    versa), every note would flip between two digests and re-index itself
    forever."""
    seen = []

    class _Engine:
        def index(self, node_id, text, **kw):
            seen.append(("single", kw))

        def index_many(self, payload, chunk_size=200):
            for row in payload:
                seen.append(("batch", {k: v for k, v in row.items()
                                       if k not in ("node_id", "text")}))
            return {"indexed": len(payload)}

    handle = sh.SynapseVectorHandle(_Engine(), dim=256)
    note = _note()
    ref = _Ref()

    await handle.index(ref, "본문", note)
    await handle.index_batch([(ref, "본문", None, note)])

    single = dict(seen[0][1])
    batch = dict(seen[1][1])
    for field in ("title", "tags", "importance", "pinned"):
        assert single[field] == batch[field], (
            f"{field} differs between the write paths: "
            f"{single[field]!r} vs {batch[field]!r}"
        )


@pytest.mark.asyncio
async def test_a_caller_without_a_note_still_works():
    """Not every write has a Note — that path must stay valid, just bare."""
    seen = []

    class _Engine:
        def index(self, node_id, text, **kw):
            seen.append(kw)

    handle = sh.SynapseVectorHandle(_Engine(), dim=256)
    assert await handle.index(_Ref(), "본문") == 1
    assert seen[0].get("kind") == "daily"
    assert "title" not in seen[0]


# ── the one-time upgrade ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_write_contract_invalidates_once_then_stops():
    """Existing rows are only re-offered when their note's timestamp moves
    or their digest is blank. Without this the richer write path would
    reach only notes edited after the deploy, leaving the vault split
    between live and dead ranking features — worse than uniformly dead."""
    class _Store:
        def __init__(self):
            self.params = {}
            self.cleared = 0

        def get_param(self, k):
            return self.params.get(k)

        def put_param(self, k, v):
            self.params[k] = v

        def clear_content_shas(self):
            self.cleared += 1
            return 4104

    store = _Store()
    handle = sh.SynapseVectorHandle(SimpleNamespace(store=store), dim=256)

    assert await handle.ensure_write_contract() == 4104
    assert store.cleared == 1
    # Idempotent: a second warm-up must not blank the vault again.
    assert await handle.ensure_write_contract() == 0
    assert store.cleared == 1


@pytest.mark.asyncio
async def test_write_contract_survives_an_unreadable_marker():
    """A corrupt marker means "old", not a crash on the warm-up path."""
    class _Store:
        params = {"geny_write_contract": b"not-a-number"}
        cleared = 0

        def get_param(self, k):
            return self.params.get(k)

        def put_param(self, k, v):
            self.params[k] = v

        def clear_content_shas(self):
            type(self).cleared += 1
            return 7

    handle = sh.SynapseVectorHandle(SimpleNamespace(store=_Store()), dim=256)
    assert await handle.ensure_write_contract() == 7


@pytest.mark.asyncio
async def test_the_version_skew_fallback_does_not_break_on_an_old_signature():
    """The no-batch branch exists so a version skew cannot take memory out
    entirely. Sending it fields an older engine never accepted would turn
    that safety net into the failure it was written to prevent."""
    seen = []

    class _OldEngine:
        # No `index_many`, and an `index` that predates the metadata.
        def index(self, node_id, text, *, kind="note"):
            seen.append({"node_id": node_id, "kind": kind})

    handle = sh.SynapseVectorHandle(_OldEngine(), dim=256)
    assert await handle.index_batch([(_Ref(), "본문", None, _note())]) == 1
    assert seen == [{"node_id": "session/daily/n.md", "kind": "daily"}]


@pytest.mark.asyncio
async def test_a_kwargs_engine_receives_everything():
    """The other side of the same coin: an engine that accepts **kwargs
    must not be starved of the metadata."""
    seen = []

    class _KwEngine:
        def index(self, node_id, text, **kw):
            seen.append(kw)

    handle = sh.SynapseVectorHandle(_KwEngine(), dim=256)
    await handle.index_batch([(_Ref(), "본문", None, _note())])
    assert seen[0]["title"] == "제목"
    assert seen[0]["importance"] == 1.5


# ── the label round-trip ─────────────────────────────────────────────

def test_weight_round_trips_back_to_its_label():
    """Readers colour by the label. Deriving it server-side keeps the
    scale in one module — a client copy is the copy that drifts."""
    for label in ("critical", "high", "medium", "low"):
        assert sh.importance_label(sh._importance_weight(label)) == label


def test_an_off_scale_weight_snaps_to_the_nearest_label():
    assert sh.importance_label(1.9) == "critical"
    assert sh.importance_label(0.6) == "low"


def test_a_junk_weight_reads_neutral():
    """Never blank, never a crash — an unknown weight is 'medium'."""
    assert sh.importance_label(None) == "medium"
    assert sh.importance_label("어쩌구") == "medium"
