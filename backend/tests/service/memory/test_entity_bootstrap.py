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
    def __init__(
        self,
        *,
        raises: bool = False,
        update_raises: bool = False,
        update_returns: bool = True,
    ) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.update_calls: List[Dict[str, Any]] = []
        self.raises = raises
        self.update_raises = update_raises
        self.update_returns = update_returns
        self.memory_dir = Path("/tmp/__entity_bootstrap_unused__")

    def write_note(self, **kwargs):
        if self.raises:
            raise RuntimeError("write_note exploded")
        self.calls.append(kwargs)
        return f"entities/{kwargs.get('filename_override', 'x').split('/')[-1]}"

    def update_note(self, filename: str, *, content=None, **kwargs):
        if self.update_raises:
            raise RuntimeError("update_note exploded")
        self.update_calls.append(
            {"filename": filename, "content": content, **kwargs},
        )
        return self.update_returns


class _FakeSTMEntry:
    def __init__(self, metadata: Dict[str, Any]) -> None:
        self.metadata = metadata


class _FakeSTM:
    def __init__(self, entries: List[_FakeSTMEntry]) -> None:
        self._entries = entries

    def load_all(self) -> List[_FakeSTMEntry]:
        return list(self._entries)


class _FakeMemoryManager:
    def __init__(
        self,
        *,
        writer: Optional[_FakeWriter] = None,
        memory_dir: Optional[Path] = None,
        stm_entries: Optional[List[_FakeSTMEntry]] = None,
    ) -> None:
        self._structured_writer = writer
        if memory_dir is not None and writer is not None:
            writer.memory_dir = memory_dir
        self.short_term = _FakeSTM(stm_entries or [])


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


def test_existing_file_refreshes_stats(tmp_path: Path) -> None:
    """Cycle 20260501_2 F3 — when the entity file already exists,
    the hook recomputes stats from the caller's STM and overwrites
    the body via update_note. Without this, the bootstrap stub
    body persists forever and the user sees the placeholder text
    "memory_distill 을 호출하면 …" indefinitely."""
    stm_entries = [
        _FakeSTMEntry({
            "event_id": "EVT-1",
            "kind": "task_request",
            "direction": "out",
            "counterpart_id": "sub-1",
            "counterpart_role": "paired_subworker",
            "payload": {
                "files_written": ["out.md", "log.txt"],
                "bash_commands": ["ls -la"],
                "duration_ms": 1234,
                "cost_usd": 0.01,
            },
        }),
        _FakeSTMEntry({
            "event_id": "EVT-2",
            "kind": "tool_run_summary",
            "direction": "in",
            "counterpart_id": "sub-1",
            "counterpart_role": "paired_subworker",
            "payload": {"files_written": ["out.md"], "errors": []},
        }),
        # Different counterpart — must NOT contribute to sub-1's stats
        _FakeSTMEntry({
            "event_id": "EVT-3",
            "kind": "user_chat",
            "direction": "in",
            "counterpart_id": "owner:alice",
            "counterpart_role": "user",
        }),
    ]
    writer = _FakeWriter()
    mm = _FakeMemoryManager(
        writer=writer, memory_dir=tmp_path, stm_entries=stm_entries,
    )

    entities_dir = tmp_path / "entities"
    entities_dir.mkdir(parents=True, exist_ok=True)
    (entities_dir / "sub-1.md").write_text(
        "_(legacy stub body)_", encoding="utf-8",
    )

    rel = maybe_bootstrap_entity(mm, _meta())
    assert rel == "entities/sub-1.md"
    # write_note must NOT have been called — refresh path uses update_note
    assert writer.calls == []
    assert len(writer.update_calls) == 1
    body = writer.update_calls[0]["content"]
    # Stats are present and reflect the matching events for sub-1 only
    assert "Events observed: **2**" in body
    assert "task_request=1" in body
    assert "tool_run_summary=1" in body
    assert "out.md" in body
    assert "log.txt" in body
    # owner:alice's user_chat is filtered out
    assert "user_chat" not in body
    # No more bootstrap stub language in the new body
    assert "memory_distill 을 호출하면" not in body


def test_refresh_returns_none_when_update_note_fails(tmp_path: Path) -> None:
    """Best-effort: a raising update_note must not leak out of the
    hook (record_message is on the hot path)."""
    writer = _FakeWriter(update_raises=True)
    mm = _FakeMemoryManager(
        writer=writer, memory_dir=tmp_path,
        stm_entries=[_FakeSTMEntry({
            "event_id": "EVT-1",
            "kind": "task_request",
            "direction": "out",
            "counterpart_id": "sub-1",
            "counterpart_role": "paired_subworker",
        })],
    )
    entities_dir = tmp_path / "entities"
    entities_dir.mkdir(parents=True, exist_ok=True)
    (entities_dir / "sub-1.md").write_text("legacy", encoding="utf-8")

    out = maybe_bootstrap_entity(mm, _meta())
    assert out is None
    # write_note path also untouched
    assert writer.calls == []


def test_refresh_returns_none_when_no_matching_events(tmp_path: Path) -> None:
    """If for some reason the STM has no matching counterpart_id
    yet (e.g. the just-recorded line hasn't flushed), the refresh
    returns None and leaves the existing body untouched. We do
    NOT re-stub — the stub is for genuinely fresh files only."""
    writer = _FakeWriter()
    mm = _FakeMemoryManager(
        writer=writer, memory_dir=tmp_path, stm_entries=[],
    )
    entities_dir = tmp_path / "entities"
    entities_dir.mkdir(parents=True, exist_ok=True)
    body_before = "preexisting body"
    (entities_dir / "sub-1.md").write_text(body_before, encoding="utf-8")

    assert maybe_bootstrap_entity(mm, _meta()) is None
    assert writer.calls == []
    assert writer.update_calls == []
    assert (entities_dir / "sub-1.md").read_text(encoding="utf-8") == body_before


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
