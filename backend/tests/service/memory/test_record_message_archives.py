"""Memory v2 PR 2 — record_message → conversations/ auto-write hook.

Pins the contract:

  * Every InteractionEvent-shaped record_message call writes a
    ``conversations/<date>/<id>.md`` file.
  * The STM jsonl line carries
    ``metadata.payload.conversation_ref`` pointing at that file.
  * Legacy metadata (no event_id) skips the archive but the STM
    line still lands (degraded mode).
  * Archive failures never propagate — the STM line is recorded
    regardless (best-effort invariant).
  * payload pre-existing keys (tools_used / files_written / cost)
    are preserved on a tool_run_summary turn — only conversation_ref
    is *added*.
  * The hook fires *before* entity_bootstrap so the recent-conversations
    section in entities/<id>.md (PR 16) sees the file.

Pure-Python tests; no SDK / real LLM. Uses ``tmp_path`` so the
manager touches disk under pytest's per-test sandbox.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from service.memory.conversation_archiver import (
    LONG_BODY_THRESHOLD,
    ArchivedConversation,
)
from service.memory.frontmatter import parse_frontmatter
from service.memory.interaction_event import (
    CounterpartRole,
    Direction,
    Kind,
    canonical_user_id,
    make_event_metadata,
)
from service.memory.manager import (
    SessionMemoryManager,
    _augment_meta_with_conversation_ref,
)


# ─────────────────────────────────────────────────────────────────
# Module-level helper — pure function tests
# ─────────────────────────────────────────────────────────────────


class TestAugmentMetaWithConversationRef:
    def test_adds_conversation_ref_to_empty_payload(self):
        meta = make_event_metadata(
            kind=Kind.USER_CHAT,
            direction=Direction.IN,
            counterpart_id="owner:test",
            counterpart_role=CounterpartRole.USER,
        )
        archived = ArchivedConversation(
            relative_path="conversations/2026-05-01/01-22-12__user__abcd1234.md",
            absolute_path="/dev/null",
            importance="medium",
            event_id=meta["event_id"],
        )
        new_meta = _augment_meta_with_conversation_ref(meta, archived)
        assert new_meta["payload"]["conversation_ref"] == archived.relative_path

    def test_preserves_existing_payload_keys(self):
        # tool_run_summary brings tools_used / files_written / cost
        # — none of these may be lost by the augmentation.
        meta = make_event_metadata(
            kind=Kind.TOOL_RUN_SUMMARY,
            direction=Direction.IN,
            counterpart_id="cp",
            counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            payload={
                "status": "ok",
                "tools_used": ["Write"],
                "files_written": ["/tmp/x.txt"],
                "cost_usd": 0.07,
            },
        )
        archived = ArchivedConversation(
            relative_path="conversations/2026-05-01/01-22-31__user__zzzz5678.md",
            absolute_path="/dev/null",
            importance="high",
            event_id=meta["event_id"],
        )
        new_meta = _augment_meta_with_conversation_ref(meta, archived)
        payload = new_meta["payload"]
        assert payload["status"] == "ok"
        assert payload["tools_used"] == ["Write"]
        assert payload["files_written"] == ["/tmp/x.txt"]
        assert payload["cost_usd"] == 0.07
        assert payload["conversation_ref"] == archived.relative_path

    def test_returns_new_dict_not_mutating_caller(self):
        meta = {"event_id": "x", "payload": {"k": "v"}}
        archived = ArchivedConversation(
            relative_path="conversations/2026-05-01/x.md",
            absolute_path="/dev/null", importance="low", event_id="x",
        )
        new_meta = _augment_meta_with_conversation_ref(meta, archived)
        assert new_meta is not meta
        assert new_meta["payload"] is not meta["payload"]
        # original payload still has only its original key
        assert "conversation_ref" not in meta["payload"]

    def test_overwrites_stale_conversation_ref(self):
        # Stress: a stale conversation_ref from a previous turn
        # (e.g. from a re-record after a crash) gets overwritten.
        meta = {
            "event_id": "x",
            "payload": {"conversation_ref": "conversations/old-stub.md"},
        }
        archived = ArchivedConversation(
            relative_path="conversations/2026-05-01/fresh.md",
            absolute_path="/dev/null", importance="medium", event_id="x",
        )
        new_meta = _augment_meta_with_conversation_ref(meta, archived)
        assert new_meta["payload"]["conversation_ref"] == "conversations/2026-05-01/fresh.md"


# ─────────────────────────────────────────────────────────────────
# record_message integration
# ─────────────────────────────────────────────────────────────────


def _read_jsonl_lines(jsonl_path: Path):
    return [json.loads(l) for l in jsonl_path.read_text(encoding="utf-8").splitlines() if l.strip()]


class TestRecordMessageArchives:
    """End-to-end: SessionMemoryManager.record_message must write
    both the STM jsonl line *and* the conversations/<id>.md file,
    with the line carrying a payload.conversation_ref pointer.
    """

    def test_user_chat_writes_both_stm_and_conversation(self, tmp_path: Path):
        mgr = SessionMemoryManager(str(tmp_path))
        mgr.initialize()
        meta = make_event_metadata(
            kind=Kind.USER_CHAT,
            direction=Direction.IN,
            counterpart_id=canonical_user_id("alice"),
            counterpart_role=CounterpartRole.USER,
        )
        body = "안녕! 워커한테 부탁할 게 있어. 이거 좀 길게 길게 길게 길게 더 길게."
        mgr.record_message("user", body, metadata=meta)

        # STM jsonl line written
        jsonl = tmp_path / "transcripts" / "session.jsonl"
        lines = _read_jsonl_lines(jsonl)
        assert len(lines) == 1
        line = lines[0]
        assert line["role"] == "user"
        assert line["content"] == body
        # payload.conversation_ref present
        payload = line["metadata"].get("payload") or {}
        ref = payload.get("conversation_ref")
        assert ref, f"no conversation_ref on STM line: {line['metadata']}"

        # conversations/ file written, body byte-equal
        conv_path = tmp_path / "memory" / ref
        assert conv_path.is_file()
        text = conv_path.read_text(encoding="utf-8")
        front, parsed_body = parse_frontmatter(text)
        assert front["category"] == "conversations"
        assert front["event_id"] == meta["event_id"]
        assert body in parsed_body  # full body preserved

    def test_legacy_metadata_skips_archive_but_still_records_stm(self, tmp_path: Path):
        # Pre-cycle metadata (no event_id) — InteractionEvent parse
        # returns None, archiver no-ops, but STM still gets the line.
        mgr = SessionMemoryManager(str(tmp_path))
        mgr.initialize()
        mgr.record_message("user", "legacy line", metadata={"foo": "bar"})

        jsonl = tmp_path / "transcripts" / "session.jsonl"
        lines = _read_jsonl_lines(jsonl)
        assert len(lines) == 1
        assert lines[0]["content"] == "legacy line"
        payload = lines[0]["metadata"].get("payload") or {}
        assert "conversation_ref" not in payload

        # No conversations/ file produced
        conv_dir = tmp_path / "memory" / "conversations"
        assert not conv_dir.exists() or not list(conv_dir.rglob("*.md"))

    def test_long_body_preserved_full_in_conversations(self, tmp_path: Path):
        mgr = SessionMemoryManager(str(tmp_path))
        mgr.initialize()
        long_body = "p\n" + ("x" * (LONG_BODY_THRESHOLD + 1000))
        meta = make_event_metadata(
            kind=Kind.USER_CHAT,
            direction=Direction.OUT,
            counterpart_id=canonical_user_id("alice"),
            counterpart_role=CounterpartRole.USER,
        )
        mgr.record_message("assistant", long_body, metadata=meta)

        jsonl = tmp_path / "transcripts" / "session.jsonl"
        lines = _read_jsonl_lines(jsonl)
        ref = lines[0]["metadata"]["payload"]["conversation_ref"]
        conv_path = tmp_path / "memory" / ref
        text = conv_path.read_text(encoding="utf-8")
        _, parsed_body = parse_frontmatter(text)
        # Plan §1.6.6 — conversations/ never truncates.
        assert ("x" * (LONG_BODY_THRESHOLD + 1000)) in parsed_body
        # importance auto-promoted to high for long body
        front, _ = parse_frontmatter(text)
        assert front["importance"] == "high"

    def test_tool_run_summary_payload_preserves_existing_keys(self, tmp_path: Path):
        mgr = SessionMemoryManager(str(tmp_path))
        mgr.initialize()
        payload = {
            "status": "ok",
            "tools_used": ["Write"],
            "files_written": ["/tmp/foo.txt"],
            "cost_usd": 0.0709,
            "duration_ms": 15454,
        }
        meta = make_event_metadata(
            kind=Kind.TOOL_RUN_SUMMARY,
            direction=Direction.IN,
            counterpart_id="cp-1",
            counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            linked_event_id="parent-event",
            payload=payload,
        )
        body = "[SUB_WORKER_RESULT]\nstatus: ok\nsummary: done\n"
        mgr.record_message("user", body, metadata=meta)

        jsonl = tmp_path / "transcripts" / "session.jsonl"
        lines = _read_jsonl_lines(jsonl)
        line_payload = lines[0]["metadata"]["payload"]
        # All original payload keys preserved
        assert line_payload["status"] == "ok"
        assert line_payload["tools_used"] == ["Write"]
        assert line_payload["files_written"] == ["/tmp/foo.txt"]
        assert line_payload["cost_usd"] == 0.0709
        assert line_payload["duration_ms"] == 15454
        # Plus the new conversation_ref pointer
        assert "conversation_ref" in line_payload

    def test_archive_failure_does_not_block_stm_write(
        self, tmp_path: Path, monkeypatch
    ):
        # Force the archiver to raise on every call. The STM line
        # must still land — degradation mode (plan §2.4).
        mgr = SessionMemoryManager(str(tmp_path))
        mgr.initialize()

        def boom(*args, **kwargs):
            raise RuntimeError("disk on fire")
        monkeypatch.setattr(mgr._conversation_archiver, "archive", boom)

        meta = make_event_metadata(
            kind=Kind.USER_CHAT,
            direction=Direction.IN,
            counterpart_id=canonical_user_id("alice"),
            counterpart_role=CounterpartRole.USER,
        )
        # Should NOT raise
        mgr.record_message("user", "hello", metadata=meta)

        jsonl = tmp_path / "transcripts" / "session.jsonl"
        lines = _read_jsonl_lines(jsonl)
        assert len(lines) == 1
        # No conversation_ref because archiver failed
        payload = lines[0]["metadata"].get("payload") or {}
        assert "conversation_ref" not in payload

    def test_multiple_turns_each_get_own_conversation_file(self, tmp_path: Path):
        mgr = SessionMemoryManager(str(tmp_path))
        mgr.initialize()
        for i in range(5):
            meta = make_event_metadata(
                kind=Kind.USER_CHAT,
                direction=Direction.IN,
                counterpart_id=canonical_user_id("alice"),
                counterpart_role=CounterpartRole.USER,
            )
            mgr.record_message("user", f"message {i} — long enough body to avoid low importance", metadata=meta)

        jsonl = tmp_path / "transcripts" / "session.jsonl"
        lines = _read_jsonl_lines(jsonl)
        assert len(lines) == 5

        # 5 distinct conversation files
        conv_files = list((tmp_path / "memory" / "conversations").rglob("*.md"))
        assert len(conv_files) == 5

        # Each STM line points to a *unique* conversation_ref
        refs = {l["metadata"]["payload"]["conversation_ref"] for l in lines}
        assert len(refs) == 5

    def test_archive_runs_before_entity_bootstrap(self, tmp_path: Path, monkeypatch):
        """Plan §4.1 — record_message hook chain order:
        STM write → conversations/ → daily index → dms index →
        entity_bootstrap. The archive must fire *before*
        entity_bootstrap because Phase 6 PR 16 will have entity
        Stats reference the just-written conversation file.

        We assert the order via a call log monkeypatch.
        """
        mgr = SessionMemoryManager(str(tmp_path))
        mgr.initialize()

        call_log = []
        original_archive = mgr._conversation_archiver.archive

        def archive_log(*a, **k):
            call_log.append("archive")
            return original_archive(*a, **k)

        def bootstrap_log(_mgr, _meta):
            call_log.append("bootstrap")

        monkeypatch.setattr(mgr._conversation_archiver, "archive", archive_log)
        monkeypatch.setattr(
            "service.memory.entity_bootstrap.maybe_bootstrap_entity",
            bootstrap_log,
        )

        meta = make_event_metadata(
            kind=Kind.USER_CHAT,
            direction=Direction.IN,
            counterpart_id=canonical_user_id("alice"),
            counterpart_role=CounterpartRole.USER,
        )
        mgr.record_message("user", "hello with enough body to go medium", metadata=meta)

        # Archive call must precede bootstrap call.
        assert call_log == ["archive", "bootstrap"], call_log
