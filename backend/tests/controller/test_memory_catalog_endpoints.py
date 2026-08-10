"""Progressive vault browsing over HTTP — effect-proving tests.

The sidebar asks in order, and each step must cost what it is worth:

    open the panel   → a count            /memory/overview
    expand it        → counts per day     /memory/overview
    expand a day     → that day's list    /memory/day/{day}
    open a note      → one body           /memory/files/{filename}

What this replaces answered the first three by walking every note — 3.2 s and
4.8 MB of bodies held in memory to produce a single number — and shipped the
whole graph (5,384 nodes, 4.3 MB) whenever the graph tab was opened.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller import memory_controller as mc


class _Catalog:
    """Index handle stand-in. Records what was asked for."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def catalog_counts(self, *, by="kind", kind=None):
        self.calls.append(("counts", by, kind))
        if by == "kind":
            return [("observations", 20), ("note", 2)]
        return [("2026-08-02", 8), ("2026-08-01", 14)]

    async def catalog_page(self, *, day=None, kind=None, limit=100, offset=0):
        self.calls.append(("page", day, kind, limit, offset))
        return [
            {"id": f"Scope.SESSION/observations/n{i}.md", "kind": "observations",
             "title": f"note {i}", "updated_at": 1.0 + i, "text_len": 100,
             "pinned": False, "importance": 1.0}
            for i in range(min(3, limit))
        ]

    async def neighbourhood(self, ids, *, depth=1, max_nodes=300, max_edges=4000):
        self.calls.append(("neighbourhood", tuple(ids), depth, max_nodes))
        return {"nodes": [{"id": i} for i in ids], "edges": [], "truncated": False}


@pytest.fixture
def client(monkeypatch):
    """Through the real router, so the declared defaults and validation are
    what gets exercised — calling the handlers directly leaves `Query(...)`
    objects where the integers should be."""
    cat = _Catalog()
    monkeypatch.setattr(mc, "_get_provider",
                        lambda _sid: SimpleNamespace(vector=lambda: cat))
    app = FastAPI()
    app.include_router(mc.router)
    return TestClient(app), cat


# ── level 1: a count, and nothing else ──────────────────────────────

def test_the_overview_is_counts_only(client):
    """THE property. Opening the panel must not fetch a single note."""
    api, cat = client
    out = api.get("/api/agents/s1/memory/overview").json()

    assert out["total"] == 22
    assert {k["kind"] for k in out["kinds"]} == {"observations", "note"}
    assert out["days"] == [{"day": "2026-08-02", "count": 8},
                           {"day": "2026-08-01", "count": 14}]
    assert all(c[0] == "counts" for c in cat.calls), (
        "the overview reached for note content"
    )


def test_the_overview_can_be_scoped(client):
    api, cat = client
    api.get("/api/agents/s1/memory/overview?kind=observations")
    assert ("counts", "day", "observations") in cat.calls


# ── level 2: one day, metadata only ─────────────────────────────────

def test_a_day_returns_that_day_only(client):
    api, cat = client
    out = api.get("/api/agents/s1/memory/day/2026-08-02").json()

    assert out["day"] == "2026-08-02"
    assert len(out["notes"]) == 3
    assert cat.calls == [("page", "2026-08-02", None, 200, 0)]


def test_a_day_carries_no_bodies(client):
    api, _cat = client
    out = api.get("/api/agents/s1/memory/day/2026-08-02").json()
    for note in out["notes"]:
        assert set(note) == {"id", "filename", "category", "title",
                             "updated_at", "char_count", "pinned"}


def test_a_day_reports_whether_there_is_more(client):
    api, _cat = client
    assert api.get("/api/agents/s1/memory/day/2026-08-02?limit=3").json()["has_more"] is True
    assert api.get("/api/agents/s1/memory/day/2026-08-02?limit=50").json()["has_more"] is False


# ── level 3: the graph, at a screen's worth ─────────────────────────

def test_the_graph_needs_a_seed(client):
    """No seed means no download — the default must not be the whole vault."""
    api, cat = client
    out = api.get("/api/agents/s1/memory/graph/around").json()
    assert out == {"nodes": [], "edges": [], "truncated": False}
    assert cat.calls == []


def test_a_day_can_seed_the_graph(client):
    """What the sidebar has in hand when a day is expanded."""
    api, cat = client
    out = api.get("/api/agents/s1/memory/graph/around?day=2026-08-02").json()

    assert len(out["nodes"]) == 3
    assert [c[0] for c in cat.calls] == ["page", "neighbourhood"]


def test_explicit_nodes_seed_the_graph(client):
    api, cat = client
    api.get("/api/agents/s1/memory/graph/around?node=a&node=b&depth=2")
    call = next(c for c in cat.calls if c[0] == "neighbourhood")
    assert call[1] == ("a", "b")
    assert call[2] == 2


def test_the_graph_depth_is_bounded(client):
    """An unbounded depth is the whole vault by another route."""
    api, _cat = client
    assert api.get("/api/agents/s1/memory/graph/around?node=a&depth=9").status_code == 422


# ── a store without a catalogue must say so, not hang ───────────────

def test_a_store_without_a_catalogue_is_reported(monkeypatch):
    monkeypatch.setattr(mc, "_get_provider",
                        lambda _sid: SimpleNamespace(vector=lambda: object()))
    app = FastAPI()
    app.include_router(mc.router)
    assert TestClient(app).get("/api/agents/s1/memory/overview").status_code == 501
