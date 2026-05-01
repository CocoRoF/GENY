"""Memory v2 PR 3 — concurrency lock invariants.

Two structural correctness goals (plan §2.1.3 + §1.6.6):

  1. **STM jsonl integrity** — N concurrent writers produce N
     well-formed jsonl lines. No half-flushed line, no garbled
     interleave. Verified by parsing every line with ``json.loads``
     and asserting the parse never raises.

  2. **conversations/ uniqueness** — N concurrent writers each
     land their own ``conversations/<date>/<id>.md`` file. No
     write loses its body to a colliding peer. The
     collision-widening loop in ``ConversationArchiver._write_to_disk``
     must be atomic-with-respect-to-disk under the new RLock.

The fixture spawns ``threading.Thread`` workers (not asyncio
tasks) because the lock under test is a ``threading.RLock``. The
production code path mixes sync and async callers, but the
threading test is the strictest stress: it actually runs in
parallel through different OS threads, whereas asyncio tasks
serialise on the event loop. If threading works, asyncio is
trivially safe.

Why ``threading.Barrier``: maximises the chance of true
contention. Without the barrier the OS scheduler tends to run the
threads sequentially. The barrier holds every thread at the start
line and releases them simultaneously.
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
    mgr = SessionMemoryManager(str(tmp_path))
    mgr.initialize()
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

    def test_distinct_conversation_files_per_turn(self, initialised_manager):
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

        # 100 distinct conversations/ files
        conv_files = list((tmp_path / "memory" / "conversations").rglob("*.md"))
        assert len(conv_files) == N_THREADS, (
            f"expected {N_THREADS} conversations/ files, got {len(conv_files)}"
        )

        # Every STM jsonl line points to a unique, present
        # conversations/ file.
        jsonl = tmp_path / "transcripts" / "session.jsonl"
        refs = set()
        for raw in jsonl.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            rec = json.loads(raw)
            ref = (rec.get("metadata") or {}).get("payload", {}).get("conversation_ref")
            assert ref, f"line missing conversation_ref: {rec.get('metadata')}"
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
