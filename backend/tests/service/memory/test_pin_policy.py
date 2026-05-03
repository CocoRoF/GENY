"""Tests for ``service.memory.pin_policy`` and the host-side pinned-facts wiring.

Memory v2 PR 12. Verifies:

  1. ``promote_to_critical`` writes a copy of an insight under the
     ``critical`` category with the ``pinned``/``auto-pinned`` tag set.
  2. ``make_promote_callback`` chains additional callbacks safely.
  3. ``LongTermMemory.load_pinned`` returns a ``MemoryEntry`` whose
     content carries the bodies of files in ``memory/critical/``
     plus the body of ``MEMORY.md``.
  4. ``LongTermMemory._extract_keywords`` and ``_normalise_for_search``
     handle Korean + English mixed input and Hangul prefix expansion.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List

import pytest

from service.memory.pin_policy import (
    make_promote_callback,
    promote_to_critical,
)
from service.memory.long_term import (
    LongTermMemory,
    _extract_keywords,
    _normalise_for_search,
)
from service.memory.structured_writer import PINNED_CATEGORY


# ── Fakes ────────────────────────────────────────────────────────────


class _FakeMgr:
    """Captures ``write_note`` calls so we can assert tag/category routing."""

    def __init__(self) -> None:
        self.notes: List[Dict[str, Any]] = []

    def write_note(self, **kwargs: Any) -> str:
        self.notes.append(kwargs)
        return f"{kwargs['category']}/{kwargs['title']}.md"


# ── promote_to_critical ──────────────────────────────────────────────


def test_promote_to_critical_routes_to_pinned_category():
    mgr = _FakeMgr()
    promote_to_critical(
        {
            "title": "User prefers 주인님",
            "content": "Call them 주인님.",
            "category": "insights",
            "tags": ["korean"],
            "importance": "high",
        },
        mgr,
    )
    assert len(mgr.notes) == 1
    note = mgr.notes[0]
    assert note["category"] == PINNED_CATEGORY
    assert "pinned" in note["tags"]
    assert "auto-pinned" in note["tags"]
    assert "from:insights" in note["tags"]
    assert note["importance"] == "high"
    assert note["source"] == "auto_pinned"


def test_promote_to_critical_skips_when_no_write_note():
    """Manager without ``write_note`` is a no-op (e.g. tests)."""

    class Bare: ...
    promote_to_critical({"title": "x", "content": "y"}, Bare())  # no raise


def test_promote_to_critical_ignores_empty_content():
    mgr = _FakeMgr()
    promote_to_critical({"title": "no body", "content": ""}, mgr)
    assert mgr.notes == []


def test_make_promote_callback_chains_extras():
    mgr = _FakeMgr()
    side: List[str] = []

    def emit(insight: Dict[str, Any], _mgr: Any) -> None:
        side.append(insight["title"])

    cb = make_promote_callback(extra_callbacks=[emit])
    cb({"title": "Pin me", "content": "...", "importance": "high"}, mgr)
    assert len(mgr.notes) == 1
    assert side == ["Pin me"]


def test_make_promote_callback_isolates_failures():
    """A throwing extra callback must not block the others."""
    mgr = _FakeMgr()
    side: List[str] = []

    def boom(_i, _m): raise RuntimeError("boom")

    def fine(insight, _m): side.append(insight["title"])

    cb = make_promote_callback(extra_callbacks=[boom, fine])
    cb({"title": "still works", "content": "..."}, mgr)
    assert len(mgr.notes) == 1
    assert side == ["still works"]


# ── LongTermMemory.load_pinned ───────────────────────────────────────


@pytest.fixture
def ltm_dir(tmp_path: Path) -> Path:
    """Create a session storage with empty memory/ ready to receive files."""
    storage = tmp_path / "session"
    (storage / "memory").mkdir(parents=True)
    return storage


def test_load_pinned_returns_none_when_empty(ltm_dir: Path):
    ltm = LongTermMemory(str(ltm_dir))
    ltm.ensure_directory()
    assert ltm.load_pinned() is None


def test_load_pinned_picks_up_critical_files(ltm_dir: Path):
    ltm = LongTermMemory(str(ltm_dir))
    ltm.ensure_directory()
    crit = ltm_dir / "memory" / "critical"
    crit.mkdir()
    (crit / "user_call.md").write_text(
        "---\ntitle: 주인님 호칭\nimportance: high\n---\n\n"
        "Call the user 주인님.\n",
        encoding="utf-8",
    )
    entry = ltm.load_pinned(max_chars=2000)
    assert entry is not None
    assert "주인님" in entry.content
    # Frontmatter is stripped — only the body should be visible.
    assert "title:" not in entry.content
    assert entry.metadata.get("layer") == "pinned"


def test_load_pinned_includes_main_memory_md(ltm_dir: Path):
    ltm = LongTermMemory(str(ltm_dir))
    ltm.ensure_directory()
    main_path = ltm_dir / "memory" / ltm.MAIN_FILE
    main_path.write_text("Persistent fact: deadline is Friday.\n", encoding="utf-8")
    entry = ltm.load_pinned(max_chars=2000)
    assert entry is not None
    assert "deadline is Friday" in entry.content


def test_load_pinned_caps_to_max_chars(ltm_dir: Path):
    ltm = LongTermMemory(str(ltm_dir))
    ltm.ensure_directory()
    crit = ltm_dir / "memory" / "critical"
    crit.mkdir()
    (crit / "long.md").write_text("a" * 5000, encoding="utf-8")
    entry = ltm.load_pinned(max_chars=200)
    assert entry is not None
    assert len(entry.content) <= 220  # heading + ellipsis tolerated


# ── Keyword normalisation ────────────────────────────────────────────


def test_normalise_for_search_nfc_and_casefold():
    # Compose / decompose differ in raw form but must compare equal
    # after NFC + casefold.
    composed = "주인님"
    decomposed = "주인님"
    assert _normalise_for_search(composed) == _normalise_for_search(decomposed)
    assert _normalise_for_search("Hello") == "hello"


def test_extract_keywords_drops_english_stopwords():
    out = _extract_keywords("how is the weather?")
    assert out == ["weather"]


def test_extract_keywords_keeps_single_hangul_token():
    out = _extract_keywords("주인님")
    assert "주인님" in out
    # Prefix expansion exposes the 2-syllable form too.
    assert "주인" in out


def test_extract_keywords_strips_korean_postposition():
    """주인님이라고 → both whole token and the noun stem are emitted."""
    out = _extract_keywords("주인님이라고 부르랬잖아")
    assert "주인님이라고" in out
    assert "주인님" in out  # 3-syllable prefix
    assert "주인" in out    # 2-syllable prefix
