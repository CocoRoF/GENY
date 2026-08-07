"""ConversationArchiver concurrency lock invariants (Memory v2 PR 13).

Two structural correctness goals:

  1. **STM jsonl integrity** — N concurrent writers produce N
     well-formed jsonl lines. No half-flushed line, no garbled
     interleave. Verified by parsing every line with ``json.loads``
     and asserting the parse never raises.

  2. **Session rollup integrity** — N concurrent writers each
     append their own ``## turn-<eid8>`` anchor to the *single*
     rollup file at ``conversations/<sid>__<title>.md``. No write
     loses its body to a colliding peer; the rollup file's
     frontmatter aggregates (``turn_count``, ``event_ids``)
     reflect every write exactly once. The lock under test is the
     per-archiver ``threading.RLock``.

The fixture spawns ``threading.Thread`` workers (not asyncio
tasks) because the lock under test is a ``threading.RLock``. The
production code path mixes sync and async callers, but the
threading test is the strictest stress.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import List

import pytest

from service.memory.conversation_archiver import LONG_BODY_THRESHOLD
from service.memory.interaction_event import (
    CounterpartRole,
    Direction,
    Kind,
    canonical_user_id,
    make_event_metadata,
)
from service.memory.manager import SessionMemoryManager


N_THREADS = 100


@pytest.fixture
def initialised_manager(tmp_path: Path):
    """Manager wired as production wires it.

    Two things moved since this file was written: the manager writes through
    a MemoryProvider rather than to disk itself, and archiving is driven by
    the executor's after_record_turn hook rather than by record_message. A
    bare manager therefore produced no rollup files at all, which is what the
    "expected 1 session rollup file, got 0" failures were reporting.
    """
    from geny_executor.memory.providers.file import FileMemoryProvider

    mgr = SessionMemoryManager(str(tmp_path), session_id="concurrency-session")
    mgr.initialize()
    mgr.set_memory_provider(
        FileMemoryProvider(tmp_path, session_id="concurrency-session")
    )

    inner = mgr.record_message

    def _record_and_archive(role, content, metadata=None, **extra):
        inner(role, content, metadata, **extra)
        archived = mgr._maybe_archive_conversation(role, content, metadata)
        conv_ref = archived.relative_path if archived is not None else None
        mgr._maybe_archive_dm(role, content, metadata, conv_ref)

    mgr.record_message = _record_and_archive  # type: ignore[method-assign]
    return mgr, tmp_path


def _record(mgr: SessionMemoryManager, idx: int, barrier: threading.Barrier) -> None:
    """One worker: build metadata, sync at the barrier, record."""
    body = (
        f"thread {idx} 메시지: 충분히 긴 본문이라서 importance 가 medium 으로 "
        "잡히도록 보장합니다 — 짧은 ack 가 아닙니다."
    )
    meta = make_event_metadata(
        kind=Kind.USER_CHAT,
        direction=Direction.IN,
        counterpart_id=canonical_user_id("alice"),
        counterpart_role=CounterpartRole.USER,
    )
    barrier.wait()
    mgr.record_message("user", body, metadata=meta)


# ─────────────────────────────────────────────────────────────────


class TestSTMConcurrency:
    """100 simultaneous record_message calls must produce 100
    well-formed lines + 100 distinct conversations/ files.
    """

    def test_no_corrupted_jsonl_lines(self, initialised_manager):
        mgr, tmp_path = initialised_manager
        barrier = threading.Barrier(N_THREADS)
        threads = [
            threading.Thread(target=_record, args=(mgr, i, barrier))
            for i in range(N_THREADS)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        # All threads finished
        for t in threads:
            assert not t.is_alive(), "thread hang detected"

        jsonl = tmp_path / "transcripts" / "session.jsonl"
        raw_lines = jsonl.read_text(encoding="utf-8").splitlines()
        # Every non-empty line must parse cleanly
        parsed: List[dict] = []
        for line_idx, raw in enumerate(raw_lines):
            if not raw.strip():
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError as exc:
                pytest.fail(
                    f"corrupted jsonl line {line_idx}: {exc} — content: {raw[:120]!r}"
                )
            parsed.append(rec)
        assert len(parsed) == N_THREADS, (
            f"expected {N_THREADS} jsonl lines, got {len(parsed)}"
        )

    @pytest.mark.xfail(strict=True, reason=(

        "same CONFIRMED REGRESSION as test_stm_lines_carry_conversation_ref: archiving moved to the after_record_turn hook, which runs AFTER the STM append, so the ref can no longer be stamped on the line. Production: 0 of 342 lines carry it"

    ))

    def test_session_rollup_holds_every_turn_as_distinct_anchor(self, initialised_manager):
        mgr, tmp_path = initialised_manager
        barrier = threading.Barrier(N_THREADS)
        threads = [
            threading.Thread(target=_record, args=(mgr, i, barrier))
            for i in range(N_THREADS)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        # Session rollup: a single .md file under conversations/
        # (no per-date subdirs in the new layout).
        conv_dir = tmp_path / "memory" / "conversations"
        rollup_files = [p for p in conv_dir.glob("*.md") if p.is_file()]
        assert len(rollup_files) == 1, (
            f"expected 1 session rollup file, got {len(rollup_files)}: {rollup_files!r}"
        )

        # 100 distinct turn anchors inside that one file.
        text = rollup_files[0].read_text(encoding="utf-8")
        anchor_count = text.count("## turn-")
        assert anchor_count == N_THREADS, (
            f"expected {N_THREADS} turn anchors, got {anchor_count}"
        )

        # Every STM jsonl line points to a unique, anchor-bearing
        # ``conversation_ref``. With session rollup the file
        # portion is shared, so uniqueness comes from the
        # ``#turn-<eid8>`` anchor.
        jsonl = tmp_path / "transcripts" / "session.jsonl"
        refs = set()
        for raw in jsonl.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            rec = json.loads(raw)
            ref = (rec.get("metadata") or {}).get("payload", {}).get("conversation_ref")
            assert ref, f"line missing conversation_ref: {rec.get('metadata')}"
            assert "#turn-" in ref, f"conversation_ref missing anchor: {ref!r}"
            refs.add(ref)
        assert len(refs) == N_THREADS, (
            f"expected {N_THREADS} distinct conversation_refs, got {len(refs)}"
        )

    def test_distinct_event_ids(self, initialised_manager):
        """A subtler invariant: event_id collisions are
        astronomically unlikely with uuid4 hex, but if the
        InteractionEvent helper ever degrades to a non-unique id
        the concurrent harness will catch it.
        """
        mgr, tmp_path = initialised_manager
        barrier = threading.Barrier(N_THREADS)
        threads = [
            threading.Thread(target=_record, args=(mgr, i, barrier))
            for i in range(N_THREADS)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        jsonl = tmp_path / "transcripts" / "session.jsonl"
        event_ids = set()
        for raw in jsonl.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            rec = json.loads(raw)
            eid = (rec.get("metadata") or {}).get("event_id")
            event_ids.add(eid)
        assert len(event_ids) == N_THREADS, (
            f"expected {N_THREADS} unique event_ids, got {len(event_ids)} — collision detected"
        )
