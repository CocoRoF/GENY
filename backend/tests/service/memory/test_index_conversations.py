"""Memory v2 PR 6 — MemoryIndexManager picks up conversations/
frontmatter 13 keys and surfaces them on ``MemoryFileInfo``.

Pins:

  * ``MemoryFileInfo`` carries event_id / kind / direction /
    counterpart / counterpart_role / linked_event_id.
  * Notes outside conversations/ leave those fields as empty
    string (back-compat: existing topics / projects / daily /
    insights / dms continue working unchanged).
  * ``_index.json`` round-trip preserves the new fields.

Hand-written conversations/ note (no archiver) so the test
exercises the *index* contract independently of how the
note got written. A regression in either ``_scan_file`` or
``MemoryFileInfo.to_dict`` shows up here regardless of which
side broke first.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from service.memory.frontmatter import render_frontmatter
from service.memory.index import MemoryFileInfo, MemoryIndexManager


CONV_FRONTMATTER = {
    "title": "[task_request → 82b10c90] test.txt 만들고...",
    "category": "conversations",
    "date": "2026-05-01",
    "ts": "2026-05-01T01:22:12+00:00",
    "event_id": "25a3ca4544db4eebaf5048433533b610",
    "role": "assistant_dm",
    "kind": "task_request",
    "direction": "out",
    "counterpart": "82b10c90-4c95-4e4f-863d-0bef73801fde",
    "counterpart_role": "paired_subworker",
    "linked_event_id": "",
    "session_id": "test-session",
    "content_chars": 287,
    "tags": ["conversation", "task_request", "paired_subworker"],
    "importance": "medium",
    "links_to": ["dms/82b10c90/2026-05-01"],
    "linked_from": [],
}


def _write_conversation(memory_dir: Path) -> str:
    """Hand-write one conversations/ note. Returns the relative path."""
    rel = "conversations/2026-05-01/01-22-12__assistant_dm__25a3ca45.md"
    path = memory_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "# task_request → 82b10c90 (paired_subworker)\n\n[DM body...]\n"
    path.write_text(render_frontmatter(CONV_FRONTMATTER, body), encoding="utf-8")
    return rel


def _write_topic(memory_dir: Path) -> str:
    rel = "topics/python-async.md"
    path = memory_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    fm = {
        "title": "Python async 패턴",
        "category": "topics",
        "tags": ["python"],
        "importance": "medium",
        "created": "2026-05-01T00:00:00+00:00",
        "modified": "2026-05-01T00:00:00+00:00",
        "source": "system",
        "session_id": "test-session",
        "links_to": [],
        "linked_from": [],
    }
    path.write_text(render_frontmatter(fm, "# Python async\n\nbody\n"), encoding="utf-8")
    return rel


# ─────────────────────────────────────────────────────────────────


class TestIndexSurfacesConversationDimensions:
    def test_conversation_note_has_interaction_event_fields(self, tmp_path: Path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        rel = _write_conversation(memory_dir)

        idx_mgr = MemoryIndexManager(str(memory_dir))
        idx_mgr.rebuild()
        info = idx_mgr.index.files[rel]

        assert info.category == "conversations"
        assert info.event_id == "25a3ca4544db4eebaf5048433533b610"
        assert info.kind == "task_request"
        assert info.direction == "out"
        assert info.counterpart == "82b10c90-4c95-4e4f-863d-0bef73801fde"
        assert info.counterpart_role == "paired_subworker"
        assert info.linked_event_id == ""

    def test_non_conversation_note_has_empty_event_fields(self, tmp_path: Path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        rel = _write_topic(memory_dir)

        idx_mgr = MemoryIndexManager(str(memory_dir))
        idx_mgr.rebuild()
        info = idx_mgr.index.files[rel]

        # back-compat: topics/ note still gets indexed correctly,
        # InteractionEvent fields stay empty.
        assert info.category == "topics"
        assert info.title == "Python async 패턴"
        assert info.event_id == ""
        assert info.kind == ""
        assert info.direction == ""
        assert info.counterpart == ""
        assert info.counterpart_role == ""
        assert info.linked_event_id == ""

    def test_index_json_round_trips_new_fields(self, tmp_path: Path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        rel = _write_conversation(memory_dir)

        idx_mgr_a = MemoryIndexManager(str(memory_dir))
        idx_mgr_a.rebuild()  # writes _index.json
        # New manager loads from disk, must see same fields
        idx_mgr_b = MemoryIndexManager(str(memory_dir))
        idx_mgr_b.load_or_rebuild()
        info_b = idx_mgr_b.index.files[rel]
        assert info_b.event_id == "25a3ca4544db4eebaf5048433533b610"
        assert info_b.kind == "task_request"
        assert info_b.counterpart == "82b10c90-4c95-4e4f-863d-0bef73801fde"

        # Direct json round-trip (catches any to_dict() regression).
        # Cycle 20260503_6 — the index moved from one monolithic
        # ``memory/_index.json`` to ``memory/_index.json`` (root
        # category map) + ``memory/<category>/_index.json`` shards.
        # File entries live in the shards now; the root carries
        # category-level aggregates and the cross-folder link graph.
        root_path = memory_dir / "_index.json"
        root_data = json.loads(root_path.read_text(encoding="utf-8"))
        assert "categories" in root_data
        assert "conversations" in root_data["categories"]
        assert root_data["categories"]["conversations"]["file_count"] >= 1

        shard_path = memory_dir / "conversations" / "_index.json"
        shard_data = json.loads(shard_path.read_text(encoding="utf-8"))
        assert "files" in shard_data
        assert shard_data["category"] == "conversations"
        file_data = shard_data["files"][rel]
        assert file_data["event_id"] == "25a3ca4544db4eebaf5048433533b610"
        assert file_data["kind"] == "task_request"

    def test_memory_file_info_from_dict_back_compat(self):
        """An old _index.json (pre-PR-6) lacks the new fields. The
        from_dict classmethod must still hydrate without raising,
        leaving the new fields as their dataclass defaults.
        """
        old_dict = {
            "filename": "topics/x.md",
            "title": "X",
            "category": "topics",
            "tags": [],
            "importance": "medium",
            "created": "",
            "modified": "",
            "source": "system",
            "char_count": 100,
            "links_to": [],
            "linked_from": [],
            "summary": None,
        }
        info = MemoryFileInfo.from_dict(old_dict)
        # Still loads, new fields default to ""
        assert info.title == "X"
        assert info.event_id == ""
        assert info.kind == ""


class TestHierarchicalIndex:
    """Cycle 20260503_6 — root + per-category shards.

    The on-disk index split into:
      - ``memory/_index.json`` (categories aggregate + link_graph + totals)
      - ``memory/<category>/_index.json`` (file entries + tag_map)

    The in-memory ``MemoryIndex`` shape is unchanged, so the
    public manager API and ``MemoryFileInfo`` consumers don't see
    any diff.
    """

    def test_rebuild_writes_root_and_per_category_shards(self, tmp_path: Path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        _write_conversation(memory_dir)
        _write_topic(memory_dir)

        idx_mgr = MemoryIndexManager(str(memory_dir))
        idx_mgr.rebuild()

        root_path = memory_dir / "_index.json"
        assert root_path.exists()
        root = json.loads(root_path.read_text(encoding="utf-8"))
        assert root["version"] == "2"
        assert {"conversations", "topics"} <= set(root["categories"])
        # Per-category shards exist.
        assert (memory_dir / "conversations" / "_index.json").exists()
        assert (memory_dir / "topics" / "_index.json").exists()
        # Root carries the link_graph (cross-folder concern).
        assert "link_graph" in root
        # Each category's description surfaces from the constants
        # table so the system-prompt vault map can render a 1-line
        # explanation per folder.
        assert root["categories"]["conversations"]["description"]
        assert root["categories"]["topics"]["description"]

    def test_per_category_shard_carries_only_its_files(self, tmp_path: Path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        rel_conv = _write_conversation(memory_dir)
        rel_topic = _write_topic(memory_dir)

        MemoryIndexManager(str(memory_dir)).rebuild()

        conv_shard = json.loads(
            (memory_dir / "conversations" / "_index.json").read_text(encoding="utf-8"),
        )
        topic_shard = json.loads(
            (memory_dir / "topics" / "_index.json").read_text(encoding="utf-8"),
        )
        assert rel_conv in conv_shard["files"]
        assert rel_topic not in conv_shard["files"]
        assert rel_topic in topic_shard["files"]
        assert rel_conv not in topic_shard["files"]
        assert conv_shard["category"] == "conversations"
        assert topic_shard["category"] == "topics"

    def test_load_from_disk_reassembles_full_index(self, tmp_path: Path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        rel_conv = _write_conversation(memory_dir)
        rel_topic = _write_topic(memory_dir)

        idx_mgr_a = MemoryIndexManager(str(memory_dir))
        idx_mgr_a.rebuild()

        # Fresh manager reads the hierarchical layout and produces
        # the same in-memory shape.
        idx_mgr_b = MemoryIndexManager(str(memory_dir))
        idx_mgr_b.load_or_rebuild()
        assert rel_conv in idx_mgr_b.index.files
        assert rel_topic in idx_mgr_b.index.files
        assert idx_mgr_b.index.files[rel_conv].kind == "task_request"

    def test_remove_file_garbage_collects_empty_shard(self, tmp_path: Path):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        rel_conv = _write_conversation(memory_dir)
        _write_topic(memory_dir)
        idx_mgr = MemoryIndexManager(str(memory_dir))
        idx_mgr.rebuild()
        conv_shard_path = memory_dir / "conversations" / "_index.json"
        assert conv_shard_path.exists()

        # Delete the only conversations file → shard should disappear.
        (memory_dir / rel_conv).unlink()
        idx_mgr.update_file(rel_conv)

        assert not conv_shard_path.exists(), \
            "empty conversations shard should be GC'd"
        # The other category's shard must survive untouched.
        assert (memory_dir / "topics" / "_index.json").exists()

    def test_render_vault_map_emits_per_category_descriptions(
        self, tmp_path: Path,
    ):
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir()
        _write_conversation(memory_dir)
        _write_topic(memory_dir)

        idx_mgr = MemoryIndexManager(str(memory_dir))
        idx_mgr.rebuild()
        rendered = idx_mgr.render_vault_map()

        # Each category line carries its 1-line description so the
        # agent can pick the right ``memory_list(category=…)``
        # argument without an extra read.
        assert "Per-session conversation rollups" in rendered
        assert "Curated subject pages" in rendered
        # And the agent gets the explicit drill-down hint.
        assert "memory_list(category" in rendered
