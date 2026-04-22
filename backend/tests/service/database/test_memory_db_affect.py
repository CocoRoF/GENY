"""STM writer affect-field extension — PR-X6F-2.

Pins that ``db_stm_add_message`` / ``db_stm_add_event`` accept the new
``emotion_vec`` / ``emotion_intensity`` kwargs, flow them into the
INSERT unchanged (vector encoded via X6-1 helper), and remain
byte-compatible when the kwargs are absent (existing callers).
"""

from __future__ import annotations

import json
from typing import Any, List, Tuple

import pytest

from service.database.memory_db_helper import (
    _coerce_emotion_vec,
    db_stm_add_event,
    db_stm_add_message,
)


class _FakeDBManager:
    """Captures ``execute_insert`` calls so we can assert on them."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, Tuple[Any, ...]]] = []
        # _is_db_available() branch
        self.db_manager = self  # so _get_db_manager returns us
        self._healthy = True

    # Duck-typed bits the helper relies on
    def _is_pool_healthy(self) -> bool:
        return self._healthy

    def execute_insert(self, query: str, params: Tuple[Any, ...]) -> int:
        self.calls.append((query, params))
        return 1


# ── _coerce_emotion_vec ─────────────────────────────────────────────


def test_coerce_none_returns_none() -> None:
    assert _coerce_emotion_vec(None) is None


def test_coerce_empty_string_returns_none() -> None:
    assert _coerce_emotion_vec("") is None


def test_coerce_preencoded_json_passes_through() -> None:
    raw = "[0.1, 0.2]"
    assert _coerce_emotion_vec(raw) == raw


def test_coerce_float_sequence_encodes_via_x6_1_helper() -> None:
    out = _coerce_emotion_vec([0.1, 0.2, 0.3])
    assert isinstance(out, str)
    assert json.loads(out) == [0.1, 0.2, 0.3]


def test_coerce_empty_sequence_returns_none() -> None:
    """Matches encode_emotion_vec semantics — empty vec = absence."""
    assert _coerce_emotion_vec([]) is None


# ── db_stm_add_message ──────────────────────────────────────────────


def test_add_message_without_affect_writes_null_null() -> None:
    """Existing callers unchanged — last two params must be NULL, NULL."""
    db = _FakeDBManager()
    assert db_stm_add_message(db, "sess-1", "user", "hello") is True
    assert len(db.calls) == 1
    query, params = db.calls[0]
    assert "emotion_vec" in query
    assert "emotion_intensity" in query
    # (entry_id, session_id, content, role, meta_str, now, emotion_vec, intensity)
    assert params[-2] is None
    assert params[-1] is None


def test_add_message_with_float_vec_encodes_and_inserts() -> None:
    db = _FakeDBManager()
    ok = db_stm_add_message(
        db, "sess-1", "assistant", "hi",
        emotion_vec=[0.15, 0.0, 0.0, 0.0, 0.0, 0.0],
        emotion_intensity=1.0,
    )
    assert ok
    _, params = db.calls[0]
    assert json.loads(params[-2]) == [0.15, 0.0, 0.0, 0.0, 0.0, 0.0]
    assert params[-1] == 1.0


def test_add_message_with_preencoded_vec_passes_through() -> None:
    db = _FakeDBManager()
    raw = "[0.1, -0.2, 0.3]"
    db_stm_add_message(
        db, "sess-1", "assistant", "ok",
        emotion_vec=raw,
        emotion_intensity=0.5,
    )
    _, params = db.calls[0]
    assert params[-2] == raw
    assert params[-1] == 0.5


def test_add_message_with_empty_vec_writes_null() -> None:
    db = _FakeDBManager()
    db_stm_add_message(
        db, "sess-1", "user", "hi",
        emotion_vec=[],
        emotion_intensity=None,
    )
    _, params = db.calls[0]
    assert params[-2] is None
    assert params[-1] is None


def test_add_message_preserves_existing_param_order() -> None:
    """Guard against accidental column reordering — existing callers pass
    entry_id / session_id / content / role / meta / timestamp in order."""
    db = _FakeDBManager()
    db_stm_add_message(
        db, "sess-A", "user", "body-text",
        metadata={"k": "v"},
    )
    query, params = db.calls[0]
    # session_id slot
    assert params[1] == "sess-A"
    # content slot
    assert params[2] == "body-text"
    # role slot
    assert params[3] == "user"
    # metadata_json slot
    assert json.loads(params[4]) == {"k": "v"}
    # new affect slots come after timestamp
    assert params[-2] is None
    assert params[-1] is None


def test_add_message_returns_false_when_db_unavailable() -> None:
    db = _FakeDBManager()
    db._healthy = False
    assert db_stm_add_message(db, "s", "user", "x") is False
    assert db.calls == []


def test_add_message_query_includes_new_columns_in_column_list() -> None:
    db = _FakeDBManager()
    db_stm_add_message(db, "s", "user", "x")
    query, params = db.calls[0]
    # both new columns appear in the column list
    assert "emotion_vec" in query
    assert "emotion_intensity" in query
    # 10 columns, 2 of which ('source', 'entry_type') are hardcoded → 8 placeholders
    assert query.count("%s") == 8
    assert len(params) == 8


# ── db_stm_add_event ────────────────────────────────────────────────


def test_add_event_without_affect_writes_null_null() -> None:
    db = _FakeDBManager()
    assert db_stm_add_event(db, "sess-1", "tool_call", {"tool": "x"}) is True
    _, params = db.calls[0]
    assert params[-2] is None
    assert params[-1] is None


def test_add_event_with_affect_inserts_them() -> None:
    db = _FakeDBManager()
    db_stm_add_event(
        db, "sess-1", "state_change", {"delta": 1},
        emotion_vec=[0.0, 0.15, 0.0, 0.0, 0.0, 0.0],
        emotion_intensity=1.0,
    )
    _, params = db.calls[0]
    assert json.loads(params[-2]) == [0.0, 0.15, 0.0, 0.0, 0.0, 0.0]
    assert params[-1] == 1.0


def test_add_event_query_placeholder_count() -> None:
    db = _FakeDBManager()
    db_stm_add_event(db, "s", "e")
    query, params = db.calls[0]
    # 10 columns total, 3 hardcoded ('source', 'entry_type', 'content') → 7 placeholders:
    # entry_id, session_id, event_name, metadata_json, entry_timestamp, emotion_vec, emotion_intensity
    assert query.count("%s") == 7
    assert len(params) == 7


# ── integration: summary → writer round-trip ────────────────────────


def test_writer_consumes_summary_output_directly() -> None:
    """End-to-end: AffectTagEmitter-style mutation → summary helper →
    db_stm_add_message kwargs, without any reshaping in between."""
    from dataclasses import dataclass
    from typing import Any as _Any

    from service.affect.summary import summarize_affect_mutations

    @dataclass
    class _Mut:
        op: str
        path: str
        value: _Any
        source: str = "t"

    entries = [
        _Mut(op="add", path="mood.joy", value=0.15),
        _Mut(op="add", path="mood.calm", value=0.045),
    ]
    vec, intensity = summarize_affect_mutations(entries)

    db = _FakeDBManager()
    db_stm_add_message(
        db, "sess-1", "assistant", "hello",
        emotion_vec=vec,
        emotion_intensity=intensity,
    )
    _, params = db.calls[0]
    # stored vector round-trips to the summary output exactly
    from service.affect import decode_emotion_vec
    assert decode_emotion_vec(params[-2]) == vec
    assert params[-1] == pytest.approx(intensity)
