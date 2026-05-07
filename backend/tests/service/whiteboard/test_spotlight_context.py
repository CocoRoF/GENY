"""Tests for the SpotlightContextSection renderer.

These tests stub out :func:`resolve_user_and_agent` so they don't need
a real agent session, and exercise the rendering / view-meta pairing.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from service.whiteboard import spotlight_context, view_ledger
from service.whiteboard.spotlight_context import render_spotlight_section
from service.whiteboard.types import SpotlightItem


@pytest.fixture(autouse=True)
def _patch_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        spotlight_context,
        "resolve_user_and_agent",
        lambda session_id: ("alice", "cocoro"),
    )


@pytest.fixture()
def custom_ledger(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> view_ledger.ViewLedger:
    ledger = view_ledger.ViewLedger(
        base_path=str(tmp_path), username="alice", agent_id="cocoro"
    )

    def _factory(username: str, agent_id: str) -> view_ledger.ViewLedger:
        return ledger

    monkeypatch.setattr(spotlight_context, "get_view_ledger", _factory)
    return ledger


def _spotlight(filename: str, *, attachments: tuple[str, ...] = ()) -> SpotlightItem:
    return SpotlightItem(
        item_id=f"id-{filename}",
        user_id="alice",
        session_id="sess-1",
        source_filename=filename,
        title=filename.replace(".md", ""),
        excerpt="hello world",
        attachments=attachments,
        created_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )


def test_empty_items_returns_empty_text(custom_ledger: view_ledger.ViewLedger) -> None:
    out = render_spotlight_section("sess-1", items=[])
    assert out == {"text": "", "images": []}


def test_render_marks_first_time_when_unseen(custom_ledger: view_ledger.ViewLedger) -> None:
    out = render_spotlight_section(
        "sess-1", items=[_spotlight("topics/foo.md")], record_injection=False
    )
    assert "first time" in out["text"]
    # `record_injection=False` must NOT touch the ledger.
    assert custom_ledger.get("topics/foo.md") is None


def test_render_marks_previously_seen_when_known(custom_ledger: view_ledger.ViewLedger) -> None:
    custom_ledger.record("topics/foo.md", "read")
    custom_ledger.record("topics/foo.md", "searched")
    out = render_spotlight_section(
        "sess-1", items=[_spotlight("topics/foo.md")], record_injection=False
    )
    assert "previously seen" in out["text"]
    assert "1× read" in out["text"]
    assert "1× searched" in out["text"]


def test_render_records_injection_event(custom_ledger: view_ledger.ViewLedger) -> None:
    render_spotlight_section(
        "sess-1", items=[_spotlight("topics/foo.md")], record_injection=True
    )
    rec = custom_ledger.get("topics/foo.md")
    assert rec is not None
    assert rec.counts.get("injected") == 1


def test_vision_capable_returns_image_paths(custom_ledger: view_ledger.ViewLedger) -> None:
    item = _spotlight(
        "inbox/cap.md",
        attachments=("_attachments/foo.png", "_attachments/bar.txt"),
    )
    out = render_spotlight_section(
        "sess-1", items=[item], vision_capable=True, record_injection=False
    )
    assert out["images"] == ["_attachments/foo.png"]


def test_vision_capable_false_returns_no_images(custom_ledger: view_ledger.ViewLedger) -> None:
    item = _spotlight(
        "inbox/cap.md",
        attachments=("_attachments/foo.png",),
    )
    out = render_spotlight_section(
        "sess-1", items=[item], vision_capable=False, record_injection=False
    )
    assert out["images"] == []
