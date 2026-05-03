"""ConversationArchiver unit tests.

Two contracts are pinned here:

  1. **Helper-level (legacy + rollup)** — ``compute_importance``,
     ``sanitize_counterpart``, ``short_event_id``, ``build_links_to``,
     ``build_tags``, ``build_title``, plus the *legacy*
     ``filename_for`` per-turn layout that the migration script
     still relies on.
  2. **Session-rollup integration (Memory v2 PR 13)** — the
     archiver writes one file per session at
     ``conversations/<sid_slug>__<title_slug>.md``, and every
     subsequent ``archive`` call appends a ``## turn-<eid8>``
     anchor with a per-turn ``<!--meta ... -->`` block + body
     verbatim. The result's ``relative_path`` carries the
     wikilink-friendly form (no ``.md``, anchor included).

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
# Archiver — session-rollup integration
# ─────────────────────────────────────────────────────────────────


def _read_rollup(path: Path) -> Dict[str, Any]:
    """Helper — load the rollup file and return its frontmatter +
    body separately (the body still carries every per-turn block).
    """
    text = path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)
    return {"text": text, "meta": meta, "body": body}


class TestArchiverSessionRollup:
    def test_archive_legacy_metadata_returns_none(self, tmp_path: Path):
        archiver = _make_archiver(tmp_path)
        # No InteractionEvent metadata → skip silently.
        assert archiver.archive("user", "hi", None) is None
        assert archiver.archive("user", "hi", {"foo": "bar"}) is None
        # No conversations/ dir was created
        assert not (tmp_path / "memory" / CATEGORY).exists()

    def test_first_archive_creates_session_rollup_file(self, tmp_path: Path):
        body = (
            "안녕! 워커한테 test.txt 만들어서 자기소개 좀 해달라고 해줄래? "
            "그 다음에 결과를 정리해서 보여줘."
        )
        assert len(body) >= SHORT_BODY_THRESHOLD
        archiver = _make_archiver(tmp_path, session_id="sess-abc123")
        result = archiver.archive("user", body, _meta())

        assert isinstance(result, ArchivedConversation)
        # Wikilink target: no .md, anchor included.
        assert result.relative_path.startswith("conversations/sess-abc123")
        assert result.relative_path.endswith(f"#turn-{result.event_id[:8]}")
        # Absolute path is the .md file with no #anchor.
        assert result.absolute_path.endswith(".md")
        on_disk = Path(result.absolute_path)
        assert on_disk.is_file()

        info = _read_rollup(on_disk)
        meta = info["meta"]

        # Session-level frontmatter shape.
        canonical = {
            "title", "category", "session_id", "date_first", "date_last",
            "turn_count", "event_ids", "kinds", "counterparts",
            "importance_max", "tags", "links_to", "linked_from",
        }
        assert canonical <= set(meta.keys()), \
            f"missing keys: {canonical - set(meta.keys())}"

        assert meta["category"] == CATEGORY
        assert meta["session_id"] == "sess-abc123"
        assert meta["turn_count"] == 1
        assert meta["importance_max"] == "medium"
        # First turn's event_id (8-char) is in event_ids.
        assert any(eid in result.event_id for eid in meta["event_ids"])
        assert "user_chat" in meta["kinds"]
        assert "owner:scenario" in meta["counterparts"]
        # Tags include base + kind + counterpart_role.
        assert "conversation" in meta["tags"]
        assert "user_chat" in meta["tags"]
        # Links_to has the daily journal date (and *not* the dms/
        # since user_chat is not a DM-class kind).
        assert "2026-05-01" in meta["links_to"]
        assert not any(l.startswith("dms/") for l in meta["links_to"])

        # Body has one ## turn anchor and the user's content verbatim.
        assert "## turn-" in info["body"]
        assert "test.txt 만들어서 자기소개" in info["body"]
        # Per-turn meta block is present (HTML comment so Obsidian
        # ignores it).
        assert "<!--meta" in info["body"]
        assert "-->" in info["body"]

    def test_subsequent_archive_appends_anchor_in_same_file(self, tmp_path: Path):
        archiver = _make_archiver(tmp_path, session_id="sess-roll")
        first = archiver.archive("user", "안녕 넌 이름이 뭐니", _meta(
            event_id_override="aaaaaaaa" + "0" * 24,
        ))
        second = archiver.archive("assistant", "안녕하세요! 저는 엘렌이에요.", _meta(
            kind=Kind.USER_CHAT,
            direction=Direction.OUT,
            event_id_override="bbbbbbbb" + "0" * 24,
        ))
        assert first is not None and second is not None
        # Same file (rollup), different anchors.
        assert first.absolute_path == second.absolute_path
        assert first.relative_path.endswith("#turn-aaaaaaaa")
        assert second.relative_path.endswith("#turn-bbbbbbbb")

        info = _read_rollup(Path(first.absolute_path))
        assert info["meta"]["turn_count"] == 2
        # event_ids contains both 8-char anchors (deduped).
        assert "aaaaaaaa" in info["meta"]["event_ids"]
        assert "bbbbbbbb" in info["meta"]["event_ids"]
        # Two anchors in the body, separated by a horizontal rule.
        assert info["body"].count("## turn-") == 2
        assert "\n---\n" in info["body"]

    def test_archive_idempotent_on_same_event_id(self, tmp_path: Path):
        """Re-archiving the same event_id is a no-op on disk —
        crucial for crash-restart safety. Turn count and event_ids
        list must not bump on the duplicate.
        """
        archiver = _make_archiver(tmp_path, session_id="sess-idem")
        m = _meta(event_id_override="cafe1234" + "0" * 24)
        first = archiver.archive("user", "duplicate?", m)
        second = archiver.archive("user", "duplicate?", m)
        assert first is not None and second is not None
        info = _read_rollup(Path(first.absolute_path))
        assert info["body"].count("## turn-cafe1234") == 1
        assert info["meta"]["turn_count"] == 1
        # event_ids list is also deduped (a single 8-char anchor).
        assert info["meta"]["event_ids"].count("cafe1234") == 1

    def test_archive_long_body_preserved_full(self, tmp_path: Path):
        body = "paragraph 0.\n" + ("x" * 6000)
        archiver = _make_archiver(tmp_path, session_id="sess-long")
        result = archiver.archive("assistant", body, _meta(
            kind=Kind.USER_CHAT, direction=Direction.OUT,
        ))
        assert result is not None
        assert result.importance == "high"  # long-body rule
        info = _read_rollup(Path(result.absolute_path))
        # 6000-char run survives verbatim inside the rollup.
        assert ("x" * 6000) in info["body"]
        # Session importance_max also lifted to high.
        assert info["meta"]["importance_max"] == "high"

    def test_archive_tool_run_summary_renders_payload_block(self, tmp_path: Path):
        archiver = _make_archiver(tmp_path, session_id="sess-tool")
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
        meta = _meta(
            kind=Kind.TOOL_RUN_SUMMARY,
            direction=Direction.IN,
            counterpart_id="82b10c90-4c95-4e4f-863d-0bef73801fde",
            counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            linked_event_id="abc123",
            payload=payload,
        )
        result = archiver.archive(
            "user",
            "[SUB_WORKER_RESULT]\nstatus: ok\nsummary: done\n",
            meta,
        )
        assert result is not None
        info = _read_rollup(Path(result.absolute_path))
        body = info["body"]
        # Anchor + structured block fields land inside the rollup.
        assert "## turn-" in body
        assert "tool_run_summary ← 82b10c90" in body
        assert "**Status:** ok" in body
        assert "**Tools:** Write" in body
        assert "/tmp/test.txt" in body
        assert "**Duration:** 15.5s" in body
        assert "**Cost:** $0.0709" in body
        assert "#### Body" in body
        assert "#### Raw payload" in body
        assert "```json" in body
        # linked_event_id surfaced in body.
        assert "abc123" in body
        # Session frontmatter aggregates the kinds + counterpart.
        assert "tool_run_summary" in info["meta"]["kinds"]
        assert "82b10c90-4c95-4e4f-863d-0bef73801fde" in info["meta"]["counterparts"]

    def test_archive_self_counterpart_skips_dms_link(self, tmp_path: Path):
        archiver = _make_archiver(tmp_path, session_id="sess-self")
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
        info = _read_rollup(Path(result.absolute_path))
        # Self-counterpart → only the daily journal link, no dms/.
        assert info["meta"]["links_to"] == ["2026-05-01"]
        # And no counterpart added (self-like is filtered).
        assert info["meta"]["counterparts"] == []

    def test_concurrent_appends_serialise_via_lock(self, tmp_path: Path):
        """Two threads archiving simultaneously must each produce a
        distinct anchor inside one rollup file (no torn writes)."""
        import threading

        archiver = _make_archiver(tmp_path, session_id="sess-conc")
        results: list[ArchivedConversation] = []
        lock = threading.Lock()
        N = 8

        def worker(i: int) -> None:
            r = archiver.archive(
                "user",
                f"turn body {i}",
                _meta(
                    event_id_override=f"{i:08x}" + "0" * 24,
                ),
            )
            if r is not None:
                with lock:
                    results.append(r)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(results) == N
        info = _read_rollup(Path(results[0].absolute_path))
        # Eight distinct anchors landed in one file.
        assert info["body"].count("## turn-") == N
        assert info["meta"]["turn_count"] == N

    def test_index_round_trips_session_rollup(self, tmp_path: Path):
        """MemoryIndexManager indexes the rollup as a single
        ``conversations`` file with the session-level title/tags
        carrying through.
        """
        from service.memory.index import MemoryIndexManager

        memory_dir = tmp_path / "memory"
        archiver = ConversationArchiver(
            str(memory_dir), session_id="sess-idx", tz=TEST_TZ,
        )
        archiver.archive(
            "assistant_dm",
            "[DM to worker]: please write test.txt",
            _meta(
                kind=Kind.TASK_REQUEST,
                direction=Direction.OUT,
                counterpart_id="82b10c90-4c95-4e4f-863d-0bef73801fde",
                counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            ),
        )

        idx_mgr = MemoryIndexManager(str(memory_dir))
        idx_mgr.rebuild()
        idx = idx_mgr.index

        # Find the session rollup file (one entry under conversations/).
        rollup_files = [k for k in idx.files if k.startswith(f"{CATEGORY}/")]
        assert len(rollup_files) == 1
        info = idx.files[rollup_files[0]]
        assert info.category == "conversations"
        # Session title is human-readable (first body line).
        assert info.title.strip().startswith("[DM to worker]")
        # 'conversation' tag carries through.
        assert "conversation" in info.tags
        assert rollup_files[0] in idx.tag_map.get("conversation", [])
