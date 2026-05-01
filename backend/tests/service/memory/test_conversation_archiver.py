"""Memory v2 PR 1 — ConversationArchiver unit tests.

Pins the contract every downstream PR depends on:

  * filename layout (``conversations/<date>/<HH-MM-SS>__<role>__<eid8>.md``)
  * canonical 17-key frontmatter (13 InteractionEvent dimensions +
    ``tags`` / ``importance`` / ``links_to`` / ``linked_from``)
  * importance heuristic (8 cases × 4 categories)
  * sub-second collision widening (eid8 → eid12 → … → eid32)
  * legacy metadata (no event_id) short-circuits to ``None`` so
    callers without InteractionEvent context skip the archive
  * tool_run_summary body carries structured + raw payload blocks
  * round-trip stability — written frontmatter parses back to the
    same dict

These tests are pure-Python and self-contained — no SessionMemoryManager,
no DB, no LLM. The archiver writes into ``tmp_path`` and the test
inspects the bytes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import pytest

from service.memory.conversation_archiver import (
    CATEGORY,
    EID_WIDTH_DEFAULT,
    LONG_BODY_THRESHOLD,
    SHORT_BODY_THRESHOLD,
    ArchivedConversation,
    ConversationArchiver,
    build_links_to,
    build_tags,
    build_title,
    compute_importance,
    filename_for,
    sanitize_counterpart,
    short_event_id,
)
from service.memory.frontmatter import parse_frontmatter
from service.memory.interaction_event import (
    CounterpartRole,
    Direction,
    Kind,
    make_event_metadata,
)


# ─────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────


# Tests pin the archiver's timezone explicitly to UTC so the
# rendered ``ts`` / filename time prefix / day journal wikilink
# don't shift under different ``GENY_TIMEZONE`` env values. The
# real production timezone (Asia/Seoul) is exercised by the
# integration suite under ``tests/integration/``.
TEST_TZ = timezone.utc

_FIXED_TS = datetime(2026, 5, 1, 1, 22, 12, 884629, tzinfo=TEST_TZ)


def _make_archiver(tmp_path: Path, *, session_id: str = "") -> ConversationArchiver:
    return ConversationArchiver(
        str(tmp_path / "memory"),
        session_id=session_id,
        tz=TEST_TZ,
    )


def _meta(
    *,
    kind: Kind = Kind.USER_CHAT,
    direction: Direction = Direction.IN,
    counterpart_id: str = "owner:scenario",
    counterpart_role: CounterpartRole = CounterpartRole.USER,
    linked_event_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    ts: datetime = _FIXED_TS,
    event_id_override: Optional[str] = None,
) -> Dict[str, Any]:
    """Build deterministic InteractionEvent metadata for tests.

    The default ts is also stamped onto the metadata so the
    archiver's clock-resolver picks it up (production agents
    pass this through automatically; tests pin it).
    """
    md = make_event_metadata(
        kind=kind,
        direction=direction,
        counterpart_id=counterpart_id,
        counterpart_role=counterpart_role,
        linked_event_id=linked_event_id,
        payload=payload,
    )
    md["ts"] = ts.isoformat()
    if event_id_override:
        md["event_id"] = event_id_override
    return md


# ─────────────────────────────────────────────────────────────────
# importance heuristic — 8 cases (cf. plan §1.6.4)
# ─────────────────────────────────────────────────────────────────


class TestComputeImportance:
    def test_critical_when_system_note_with_errors(self):
        assert compute_importance(
            kind=Kind.SYSTEM_NOTE.value,
            content_chars=120,
            payload={"errors": ["boom"]},
        ) == "critical"

    def test_high_when_task_result_with_files_written(self):
        assert compute_importance(
            kind=Kind.TASK_RESULT.value,
            content_chars=200,
            payload={"files_written": ["/x"]},
        ) == "high"

    def test_high_when_long_body(self):
        assert compute_importance(
            kind=Kind.USER_CHAT.value,
            content_chars=LONG_BODY_THRESHOLD + 1,
            payload=None,
        ) == "high"

    def test_high_when_payload_has_errors(self):
        assert compute_importance(
            kind=Kind.TOOL_RUN_SUMMARY.value,
            content_chars=120,
            payload={"errors": ["x"]},
        ) == "high"

    def test_low_when_reflection(self):
        assert compute_importance(
            kind=Kind.REFLECTION.value,
            content_chars=400,
            payload=None,
        ) == "low"

    def test_low_when_short_content(self):
        assert compute_importance(
            kind=Kind.USER_CHAT.value,
            content_chars=SHORT_BODY_THRESHOLD - 1,
            payload=None,
        ) == "low"

    def test_medium_default_for_user_chat(self):
        assert compute_importance(
            kind=Kind.USER_CHAT.value,
            content_chars=300,
            payload=None,
        ) == "medium"

    def test_medium_default_for_dm(self):
        assert compute_importance(
            kind=Kind.DM.value,
            content_chars=200,
            payload=None,
        ) == "medium"

    def test_long_body_beats_low_kind(self):
        # Reflection + 6000 chars → high (not low). The ladder
        # checks long-body before low-kind.
        assert compute_importance(
            kind=Kind.REFLECTION.value,
            content_chars=LONG_BODY_THRESHOLD + 1,
            payload=None,
        ) == "high"


# ─────────────────────────────────────────────────────────────────
# filename / sanitiser helpers
# ─────────────────────────────────────────────────────────────────


class TestFilenameHelpers:
    def test_short_event_id_default_width(self):
        eid = "25a3ca4544db4eebaf5048433533b610"
        assert short_event_id(eid) == "25a3ca45"

    def test_short_event_id_widening(self):
        eid = "25a3ca4544db4eebaf5048433533b610"
        assert short_event_id(eid, width=12) == "25a3ca4544db"

    def test_short_event_id_clamps_to_max(self):
        eid = "25a3ca4544db4eebaf5048433533b610"
        # Width above 32 clamps to full id length.
        assert short_event_id(eid, width=999) == eid

    def test_short_event_id_handles_empty(self):
        # Empty event_id should not crash; returns a stable
        # placeholder so the filename still validates.
        out = short_event_id("")
        assert out and len(out) == EID_WIDTH_DEFAULT

    def test_sanitize_owner_id(self):
        assert sanitize_counterpart("owner:gkfua00") == "owner_gkfua00"

    def test_sanitize_unicode(self):
        # Korean / mixed chars get replaced with underscores; UUIDs
        # pass through untouched.
        assert sanitize_counterpart("페어드_워커") == "______"
        assert sanitize_counterpart("82b10c90-4c95-4e4f-863d-0bef73801fde") == \
               "82b10c90-4c95-4e4f-863d-0bef73801fde"

    def test_filename_for_layout(self):
        date, name = filename_for(
            ts=_FIXED_TS,
            role="assistant_dm",
            event_id="25a3ca4544db4eebaf5048433533b610",
        )
        assert date == "2026-05-01"
        assert name == "01-22-12__assistant_dm__25a3ca45.md"


# ─────────────────────────────────────────────────────────────────
# title / tags / links_to builders
# ─────────────────────────────────────────────────────────────────


class TestBuilders:
    def test_build_title_includes_kind_arrow_cp_short_and_body(self):
        t = build_title(
            kind=Kind.TASK_REQUEST.value,
            direction=Direction.OUT.value,
            counterpart_id="82b10c90-4c95-4e4f-863d-0bef73801fde",
            content="[DM to worker]: please make test.txt with intro",
        )
        assert t.startswith("[task_request → 82b10c90]"), f"unexpected title: {t}"
        assert "test.txt" in t

    def test_build_title_no_counterpart(self):
        t = build_title(
            kind=Kind.SYSTEM_NOTE.value,
            direction=Direction.INTERNAL.value,
            counterpart_id=None,
            content="boot completed",
        )
        # internal direction collapses to a neutral arrow
        assert t == "[system_note] boot completed"

    def test_build_title_truncates_long_first_line(self):
        long_line = "a" * 200
        t = build_title(
            kind=Kind.USER_CHAT.value,
            direction=Direction.IN.value,
            counterpart_id="owner:scenario",
            content=long_line,
        )
        # title contains the kind prefix + truncated line ending in ellipsis
        assert "…" in t
        assert len(t) < 200

    def test_build_links_to_user_chat_skips_dms(self):
        # user_chat is not a DM-class kind → only the daily journal
        # link is emitted (the legacy entities/<sanitized> link was
        # retired with the entities/ category itself).
        links = build_links_to(
            kind=Kind.USER_CHAT.value,
            counterpart_id="owner:scenario",
            date="2026-05-01",
        )
        assert links == ["2026-05-01"]

    def test_build_links_to_task_request_includes_dms(self):
        links = build_links_to(
            kind=Kind.TASK_REQUEST.value,
            counterpart_id="82b10c90-4c95-4e4f-863d-0bef73801fde",
            date="2026-05-01",
        )
        assert "2026-05-01" in links
        assert "dms/82b10c90-4c95-4e4f-863d-0bef73801fde/2026-05-01" in links
        # entities/ link is no longer emitted post-Memory-v2.
        assert not any(l.startswith("entities/") for l in links)

    def test_build_links_to_self_counterpart_skips_entity_link(self):
        links = build_links_to(
            kind=Kind.REFLECTION.value,
            counterpart_id="self",
            date="2026-05-01",
        )
        # reflection on self → only the daily journal pointer
        assert links == ["2026-05-01"]

    def test_build_tags_lowercase(self):
        tags = build_tags(kind=Kind.TASK_REQUEST.value, counterpart_role="paired_subworker")
        assert tags == ["conversation", "task_request", "paired_subworker"]

    def test_build_tags_no_role(self):
        tags = build_tags(kind=Kind.SYSTEM_NOTE.value, counterpart_role=None)
        assert tags == ["conversation", "system_note"]


# ─────────────────────────────────────────────────────────────────
# Archiver — disk integration
# ─────────────────────────────────────────────────────────────────


class TestArchiverDiskIntegration:
    def test_archive_legacy_metadata_returns_none(self, tmp_path: Path):
        archiver = _make_archiver(tmp_path)
        # No InteractionEvent metadata → skip silently.
        assert archiver.archive("user", "hi", None) is None
        assert archiver.archive("user", "hi", {"foo": "bar"}) is None
        # No conversations/ dir was created
        assert not (tmp_path / "memory" / CATEGORY).exists()

    def test_archive_user_chat_writes_one_file(self, tmp_path: Path):
        # Body just above SHORT_BODY_THRESHOLD so importance = medium
        # (the heuristic flips to ``low`` for content_chars < 50).
        body = (
            "안녕! 워커한테 test.txt 만들어서 자기소개 좀 해달라고 해줄래? "
            "그 다음에 결과를 정리해서 보여줘."
        )
        assert len(body) >= SHORT_BODY_THRESHOLD, (
            f"fixture body too short ({len(body)} < {SHORT_BODY_THRESHOLD}); "
            "test asserts importance=medium which requires len >= threshold"
        )
        archiver = _make_archiver(tmp_path, session_id="sess-1")
        result = archiver.archive(
            "user",
            body,
            _meta(),
        )
        assert isinstance(result, ArchivedConversation)
        # Filename layout pinned: conversations/<date>/<HH-MM-SS>__<role>__<eid8>.md
        assert result.relative_path.startswith(
            "conversations/2026-05-01/01-22-12__user__"
        ), result.relative_path
        assert result.relative_path.endswith(".md")

        path = Path(result.absolute_path)
        assert path.is_file()

        text = path.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(text)

        # canonical 17 keys present
        canonical = {
            "title", "category", "date", "ts", "event_id", "role", "kind",
            "direction", "counterpart", "counterpart_role", "linked_event_id",
            "session_id", "content_chars", "tags", "importance",
            "links_to", "linked_from",
        }
        assert canonical <= set(meta.keys()), \
            f"missing keys: {canonical - set(meta.keys())}"

        assert meta["category"] == CATEGORY
        assert meta["kind"] == "user_chat"
        assert meta["direction"] == "in"
        assert meta["counterpart"] == "owner:scenario"
        assert meta["counterpart_role"] == "user"
        assert meta["session_id"] == "sess-1"
        assert int(meta["content_chars"]) == len(body)
        assert meta["importance"] == "medium"
        assert meta["linked_from"] == []
        # 'conversation' tag always present
        assert "conversation" in [t.lower() for t in meta["tags"]]
        # body still contains the user's actual content
        assert "test.txt 만들어서 자기소개" in body
        # Linked footer present
        assert "**Linked:**" in body

    def test_archive_long_body_preserved_full(self, tmp_path: Path):
        # The single most-important invariant of v2: long bodies
        # are *not* truncated in conversations/. Build a 6000-char
        # body, archive it, read it back, assert byte-equal.
        body = ("paragraph %d.\n" % 0) + ("x" * 6000)
        archiver = _make_archiver(tmp_path)
        result = archiver.archive("assistant", body, _meta(
            kind=Kind.USER_CHAT, direction=Direction.OUT,
        ))
        assert result is not None
        assert result.importance == "high"  # long-body rule

        on_disk = Path(result.absolute_path).read_text(encoding="utf-8")
        _, parsed_body = parse_frontmatter(on_disk)
        # The archiver's body wraps the raw content with a heading
        # and Linked footer, so we look for the original body
        # substring rather than equality.
        assert ("x" * 6000) in parsed_body

    def test_archive_tool_run_summary_renders_payload_block(self, tmp_path: Path):
        archiver = _make_archiver(tmp_path)
        payload = {
            "status": "ok",
            "tools_used": ["Write"],
            "files_written": ["/tmp/test.txt"],
            "files_read": [],
            "bash_commands": [],
            "web_fetches": [],
            "errors": [],
            "total_calls": 1,
            "ok_calls": 1,
            "failed_calls": 0,
            "duration_ms": 15454,
            "cost_usd": 0.0709,
        }
        body = "[SUB_WORKER_RESULT]\nstatus: ok\nsummary: done\n"
        meta = _meta(
            kind=Kind.TOOL_RUN_SUMMARY,
            direction=Direction.IN,
            counterpart_id="82b10c90-4c95-4e4f-863d-0bef73801fde",
            counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            linked_event_id="abc123",
            payload=payload,
        )
        result = archiver.archive("user", body, meta)
        assert result is not None
        on_disk = Path(result.absolute_path).read_text(encoding="utf-8")
        # Header line: kind ← cp_short (counterpart_role)
        assert "tool_run_summary ← 82b10c90" in on_disk
        # Structured block fields
        assert "**Status:** ok" in on_disk
        assert "**Tools:** Write" in on_disk
        assert "/tmp/test.txt" in on_disk
        assert "**Duration:** 15.5s" in on_disk
        assert "**Cost:** $0.0709" in on_disk
        # Body section then raw payload fence
        assert "## Body" in on_disk
        assert "## Raw payload" in on_disk
        assert "```json" in on_disk
        # linked_event_id surfaced in footer
        assert "abc123" in on_disk

    def test_archive_collision_widens_eid_prefix(self, tmp_path: Path):
        """Two InteractionEvents at the *same* second with the same
        role and an 8-char-prefix overlap must produce two distinct
        files (the second widens its eid prefix).
        """
        archiver = _make_archiver(tmp_path)
        eid_a = "deadbeef" + "0" * 24  # 32-char, prefix "deadbeef"
        eid_b = "deadbeef" + "1" * 24  # 32-char, prefix "deadbeef" (same 8-char prefix)

        first = archiver.archive("user", "hi a", _meta(event_id_override=eid_a))
        second = archiver.archive("user", "hi b", _meta(event_id_override=eid_b))

        assert first is not None
        assert second is not None
        assert first.relative_path != second.relative_path, \
            "collision was not resolved — the two notes share a path"

        # The second filename should carry a wider eid prefix.
        # filename shape: ...__user__<eid>.md
        a_eid = first.relative_path.split("__")[-1].rsplit(".", 1)[0]
        b_eid = second.relative_path.split("__")[-1].rsplit(".", 1)[0]
        assert len(b_eid) > len(a_eid), \
            f"expected widened eid on collision, got {len(a_eid)} vs {len(b_eid)}"

    def test_archive_round_trips_through_index_scan(self, tmp_path: Path):
        """The MemoryIndexManager must recognise conversations/ as a
        category and surface our title/tags/importance correctly.
        Phase 2 PR 6 will extend the index to surface the rest of the
        13 keys; here we only assert the existing fields round-trip.
        """
        from service.memory.index import MemoryIndexManager

        memory_dir = tmp_path / "memory"
        archiver = ConversationArchiver(str(memory_dir), session_id="sess-1", tz=TEST_TZ)
        result = archiver.archive(
            "assistant_dm",
            "[DM to worker]: please write test.txt",
            _meta(
                kind=Kind.TASK_REQUEST,
                direction=Direction.OUT,
                counterpart_id="82b10c90-4c95-4e4f-863d-0bef73801fde",
                counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            ),
        )
        assert result is not None

        idx_mgr = MemoryIndexManager(str(memory_dir))
        idx_mgr.rebuild()
        idx = idx_mgr.index

        assert result.relative_path in idx.files
        info = idx.files[result.relative_path]
        assert info.category == "conversations"
        assert info.title.startswith("[task_request → 82b10c90]")
        assert info.importance == "medium"
        # 'conversation' tag carries through
        assert "conversation" in info.tags
        # tag_map has the conversation tag
        assert result.relative_path in idx.tag_map.get("conversation", [])

    def test_archive_skips_self_counterpart_for_dms_link(self, tmp_path: Path):
        archiver = _make_archiver(tmp_path)
        result = archiver.archive(
            "internal_trigger",
            "이건 내적 반사야.",
            _meta(
                kind=Kind.REFLECTION,
                direction=Direction.INTERNAL,
                counterpart_id="self",
                counterpart_role=CounterpartRole.SELF,
            ),
        )
        assert result is not None
        text = Path(result.absolute_path).read_text(encoding="utf-8")
        meta, _ = parse_frontmatter(text)
        # self-counterpart → only the daily journal link
        assert meta["links_to"] == ["2026-05-01"], meta["links_to"]
