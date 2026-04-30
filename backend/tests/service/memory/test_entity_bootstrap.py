"""Cycle 20260430_3 Stage B — entity bootstrap helper tests.

Pins the contract:

  * legacy metadata (no event_id) → skip
  * counterpart_id ∈ {"self","system","",unknown} → skip
  * counterpart_role self / system → skip
  * structured_writer absent → skip silently
  * file already exists → skip (idempotent)
  * happy path: writes once with `category=entities`,
    `filename_override=entities/<sanitized>.md`, `source=bootstrap`
  * write_note exception → swallowed, returns None
  * sanitize parity with the distill helper
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from service.memory.entity_bootstrap import (
    _sanitize_counterpart_for_filename as bootstrap_sanitize,
    maybe_bootstrap_entity,
)


# ─────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────


class _FakeWriter:
    def __init__(self, *, raises: bool = False) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.raises = raises
        self.memory_dir = Path("/tmp/__entity_bootstrap_unused__")

    def write_note(self, **kwargs):
        if self.raises:
            raise RuntimeError("write_note exploded")
        self.calls.append(kwargs)
        return f"entities/{kwargs.get('filename_override', 'x').split('/')[-1]}"


class _FakeMemoryManager:
    def __init__(
        self,
        *,
        writer: Optional[_FakeWriter] = None,
        memory_dir: Optional[Path] = None,
    ) -> None:
        self._structured_writer = writer
        if memory_dir is not None and writer is not None:
            writer.memory_dir = memory_dir


# ─────────────────────────────────────────────────────────────────
# Sanitize parity
# ─────────────────────────────────────────────────────────────────


def test_sanitize_matches_distill_helper() -> None:
    """The bootstrap helper duplicates `_sanitize_counterpart_for_filename`
    to avoid a circular import. Both functions must produce identical
    output — drift would split entity files between the two surfaces."""
    from tools.built_in.memory_inspect_tools import (
        _sanitize_counterpart_for_filename as inspect_sanitize,
    )
    samples = [
        "owner:alice", "sub-1", "self", "", "x" * 100,
        "weird/chars#here", "session-uuid-1234",
    ]
    for s in samples:
        assert bootstrap_sanitize(s) == inspect_sanitize(s), s


# ─────────────────────────────────────────────────────────────────
# Skip rules
# ─────────────────────────────────────────────────────────────────


def test_legacy_metadata_skipped() -> None:
    writer = _FakeWriter()
    mm = _FakeMemoryManager(writer=writer)
    # legacy line — no event_id
    assert maybe_bootstrap_entity(mm, {"role": "user"}) is None
    assert maybe_bootstrap_entity(mm, None) is None
    assert maybe_bootstrap_entity(mm, {}) is None
    assert writer.calls == []


def _meta(**overrides) -> Dict[str, Any]:
    base = {
        "event_id": "EVT-1",
        "kind": "task_request",
        "direction": "out",
        "counterpart_id": "sub-1",
        "counterpart_role": "paired_subworker",
    }
    base.update(overrides)
    return base


def test_self_counterpart_skipped() -> None:
    writer = _FakeWriter()
    mm = _FakeMemoryManager(writer=writer)
    meta = _meta(counterpart_id="self", counterpart_role="self", kind="reflection")
    assert maybe_bootstrap_entity(mm, meta) is None
    assert writer.calls == []


def test_system_counterpart_skipped() -> None:
    writer = _FakeWriter()
    mm = _FakeMemoryManager(writer=writer)
    meta = _meta(counterpart_id="system", counterpart_role="system", kind="system_note")
    assert maybe_bootstrap_entity(mm, meta) is None
    assert writer.calls == []


def test_unknown_counterpart_skipped() -> None:
    writer = _FakeWriter()
    mm = _FakeMemoryManager(writer=writer)
    meta = _meta(counterpart_id="unknown")
    assert maybe_bootstrap_entity(mm, meta) is None
    assert writer.calls == []


def test_no_writer_silent() -> None:
    """SessionMemoryManager without a structured writer (early init,
    test minimal) — must skip cleanly."""
    mm = _FakeMemoryManager(writer=None)
    assert maybe_bootstrap_entity(mm, _meta()) is None


# ─────────────────────────────────────────────────────────────────
# Idempotency
# ─────────────────────────────────────────────────────────────────


def test_existing_file_skipped(tmp_path: Path) -> None:
    """File already at entities/<sanitized>.md → skip without writing."""
    writer = _FakeWriter()
    mm = _FakeMemoryManager(writer=writer, memory_dir=tmp_path)

    entities_dir = tmp_path / "entities"
    entities_dir.mkdir(parents=True, exist_ok=True)
    (entities_dir / "sub-1.md").write_text("preexisting", encoding="utf-8")

    assert maybe_bootstrap_entity(mm, _meta()) is None
    assert writer.calls == []
    # And the existing file's content stays untouched
    assert (entities_dir / "sub-1.md").read_text(encoding="utf-8") == "preexisting"


# ─────────────────────────────────────────────────────────────────
# Happy path
# ─────────────────────────────────────────────────────────────────


def test_writes_stub_for_fresh_counterpart(tmp_path: Path) -> None:
    writer = _FakeWriter()
    mm = _FakeMemoryManager(writer=writer, memory_dir=tmp_path)

    rel = maybe_bootstrap_entity(mm, _meta())
    assert rel is not None
    assert rel.endswith("sub-1.md")
    assert len(writer.calls) == 1
    args = writer.calls[0]
    assert args["category"] == "entities"
    assert args["source"] == "bootstrap"
    assert args["filename_override"] == "entities/sub-1.md"
    # Tags carry the role for downstream filter/search
    assert "paired_subworker" in args["tags"]
    assert "entity" in args["tags"]
    # Body is the static stub — no per-session data leaks in
    assert "distillation" in args["content"].lower()


def test_writes_for_user_counterpart(tmp_path: Path) -> None:
    """A first user_chat creates entities/owner_alice.md (sanitised)."""
    writer = _FakeWriter()
    mm = _FakeMemoryManager(writer=writer, memory_dir=tmp_path)

    meta = _meta(
        kind="user_chat",
        direction="in",
        counterpart_id="owner:alice",
        counterpart_role="user",
    )
    rel = maybe_bootstrap_entity(mm, meta)
    assert rel is not None
    assert writer.calls[0]["filename_override"] == "entities/owner_alice.md"


def test_write_note_exception_swallowed(tmp_path: Path) -> None:
    """write_note raising must not propagate out of the hook —
    record_message stays a single-purpose call."""
    writer = _FakeWriter(raises=True)
    mm = _FakeMemoryManager(writer=writer, memory_dir=tmp_path)
    # Must not raise
    out = maybe_bootstrap_entity(mm, _meta())
    assert out is None


# ─────────────────────────────────────────────────────────────────
# Integration with SessionMemoryManager.record_message
# ─────────────────────────────────────────────────────────────────


def test_record_message_triggers_bootstrap(monkeypatch, tmp_path) -> None:
    """End-to-end: record_message(metadata=...) reaches
    maybe_bootstrap_entity. Patch the import inside record_message's
    helper rather than spinning up a full SessionMemoryManager."""
    from service.memory import manager as mm_module
    from service.memory.manager import SessionMemoryManager
    from service.memory.interaction_event import (
        CounterpartRole, Direction, Kind, make_event_metadata,
    )

    storage = tmp_path / "storage"
    storage.mkdir()
    mgr = SessionMemoryManager(storage_path=str(storage))

    # Stub STM.add_message so we don't touch disk
    captured: List[Dict[str, Any]] = []
    monkeypatch.setattr(
        mgr._stm, "add_message",
        lambda role, content, metadata=None: captured.append(
            {"role": role, "content": content, "metadata": metadata},
        ),
    )

    # Capture the bootstrap helper invocation instead of letting it
    # touch the structured writer (which is None in this minimal setup).
    bootstrap_calls: List[Dict[str, Any]] = []
    monkeypatch.setattr(
        "service.memory.entity_bootstrap.maybe_bootstrap_entity",
        lambda self_, meta: bootstrap_calls.append({"meta": meta}),
    )

    meta = make_event_metadata(
        kind=Kind.TASK_REQUEST,
        direction=Direction.OUT,
        counterpart_id="sub-1",
        counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
    )
    mgr.record_message("assistant_dm", "hi", metadata=meta)
    assert len(captured) == 1
    assert len(bootstrap_calls) == 1
    assert bootstrap_calls[0]["meta"] == captured[0]["metadata"]
