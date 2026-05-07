"""Tests for SpotlightContextBlock — the PromptBlock adapter.

These tests don't need the real ``PipelineState`` — only the
``session_id`` attribute is touched by the block. We use a tiny stub
so the test suite stays runnable in the lightweight test venv that
doesn't carry geny_executor.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

# The block module imports ``PipelineState`` only at module load; if
# ``geny_executor`` isn't available we skip the whole module so the
# rest of the whiteboard suite still runs.
pytest.importorskip("geny_executor")

from service.whiteboard import spotlight_block, spotlight_context, view_ledger  # noqa: E402
from service.whiteboard.spotlight_block import SpotlightContextBlock  # noqa: E402
from service.whiteboard.types import SpotlightItem  # noqa: E402


@dataclass
class _FakeState:
    """Stand-in for ``PipelineState``: only ``session_id`` is read."""

    session_id: str = ""


PipelineState = _FakeState  # type: ignore[assignment]  # local alias


@pytest.fixture()
def state() -> PipelineState:
    s = PipelineState()
    s.session_id = "sess-1"
    return s


@pytest.fixture()
def fake_renderer(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Replace render_spotlight_section with a recording stub."""
    calls: dict = {"count": 0, "kwargs": []}

    def _stub(session_id: str, **kwargs: Any) -> dict:
        calls["count"] += 1
        calls["kwargs"].append({"session_id": session_id, **kwargs})
        if session_id == "with-items":
            return {"text": "[Spotlight Context]\nitem 1\n[/Spotlight Context]", "images": []}
        return {"text": "", "images": []}

    monkeypatch.setattr(spotlight_block, "render_spotlight_section", _stub)
    return calls


def test_block_renders_empty_for_empty_session(
    state: PipelineState, fake_renderer: dict
) -> None:
    block = SpotlightContextBlock()
    assert block.render(state) == ""
    assert fake_renderer["count"] == 1


def test_block_renders_with_persona_guidance_appended(
    fake_renderer: dict,
) -> None:
    state = PipelineState()
    state.session_id = "with-items"
    block = SpotlightContextBlock()
    rendered = block.render(state)
    assert rendered.startswith("[Spotlight Context]")
    # Guidance must be appended so the persona knows how to react.
    assert spotlight_context.PERSONA_GUIDANCE in rendered


def test_block_returns_empty_when_session_id_missing(
    fake_renderer: dict,
) -> None:
    state = PipelineState()
    state.session_id = ""
    block = SpotlightContextBlock()
    assert block.render(state) == ""
    # Renderer must not even be called — `session_id` gating is the
    # block's only short-circuit.
    assert fake_renderer["count"] == 0


def test_block_swallows_renderer_exceptions(
    state: PipelineState, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _raises(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(spotlight_block, "render_spotlight_section", _raises)
    block = SpotlightContextBlock()
    # Must not propagate — a buggy spotlight render cannot be allowed
    # to break every VTuber turn.
    assert block.render(state) == ""


def test_block_name_matches_idempotency_key() -> None:
    # AgentSession's tail-block append uses this exact name as the
    # idempotency key. Don't rename it without updating that site.
    assert SpotlightContextBlock().name == "whiteboard_spotlight"


# ── End-to-end-ish: real renderer + ledger, isolated tmp ──────────────


@pytest.fixture()
def isolated_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> view_ledger.ViewLedger:
    """Wire up a real ViewLedger and a fake resolver pointing at it."""
    ledger = view_ledger.ViewLedger(
        base_path=str(tmp_path), username="alice", agent_id="cocoro"
    )
    monkeypatch.setattr(
        spotlight_context,
        "resolve_user_and_agent",
        lambda session_id: ("alice", "cocoro"),
    )
    monkeypatch.setattr(
        spotlight_context, "get_view_ledger", lambda u, a: ledger
    )
    return ledger


def test_block_real_render_records_injected(
    isolated_setup: view_ledger.ViewLedger,
) -> None:
    item = SpotlightItem(
        item_id="1",
        user_id="alice",
        session_id="sess-1",
        source_filename="topics/foo.md",
        title="Foo",
        excerpt="hello",
        created_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )
    # Stub the spotlight_store to return our fixed item.
    from service.whiteboard import spotlight_store as ss

    ss.get_spotlight_store().reset_for_tests()
    ss.get_spotlight_store().add(
        user_id="alice",
        session_id="sess-1",
        source_filename=item.source_filename,
        title=item.title,
        excerpt=item.excerpt,
    )

    state = PipelineState()
    state.session_id = "sess-1"
    block = SpotlightContextBlock()
    out = block.render(state)
    assert "first time" in out  # initial render: not seen before
    rec = isolated_setup.get(item.source_filename)
    assert rec is not None
    assert rec.counts.get("injected") == 1

    # Render again — counts increase, hint flips to previously seen.
    out2 = block.render(state)
    assert "previously seen" in out2
    rec2 = isolated_setup.get(item.source_filename)
    assert rec2 is not None
    assert rec2.counts.get("injected") == 2
