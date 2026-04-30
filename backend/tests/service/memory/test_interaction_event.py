"""Cycle 20260430_2 A1 — InteractionEvent schema + helper tests.

Pins the four invariants of the cycle for the schema layer:

1. metadata that the helper produces is a *strict superset* of
   the existing STM metadata shape — five required fields plus
   optional linked_event_id / payload / caller-extras.
2. every helper call returns a non-empty, fully-populated dict
   (no empty {} ever leaks).
3. the schema is symmetric: parse(make(...)) round-trips every
   field.
4. backwards-compat: legacy jsonl lines (missing metadata) parse
   to None so callers can fall through to pre-unification paths
   without branching on missing keys.
"""

from __future__ import annotations

import pytest

from service.memory.interaction_event import (
    CounterpartRole,
    Direction,
    InteractionEventView,
    Kind,
    canonical_user_id,
    make_event_metadata,
    new_event_id,
    parse_event_metadata,
)


# ─────────────────────────────────────────────────────────────────
# canonical_user_id
# ─────────────────────────────────────────────────────────────────


def test_canonical_user_id_normalises_username() -> None:
    assert canonical_user_id("alice") == "owner:alice"
    assert canonical_user_id("  bob  ") == "owner:bob"


def test_canonical_user_id_handles_missing_owner() -> None:
    assert canonical_user_id(None) == "owner:unknown"
    assert canonical_user_id("") == "owner:unknown"
    assert canonical_user_id("   ") == "owner:unknown"


# ─────────────────────────────────────────────────────────────────
# new_event_id
# ─────────────────────────────────────────────────────────────────


def test_event_id_is_unique_at_scale() -> None:
    """Cycle 20260430_2 invariant — every event must be addressable
    on its own. A collision would let one event mask another in
    `memory_event(event_id)` lookups, so we sweep a non-trivial
    sample to catch any obvious entropy regression."""
    seen = {new_event_id() for _ in range(10_000)}
    assert len(seen) == 10_000


# ─────────────────────────────────────────────────────────────────
# make_event_metadata — canonical fields
# ─────────────────────────────────────────────────────────────────


def test_make_event_metadata_minimal_returns_full_required_set() -> None:
    meta = make_event_metadata(
        kind=Kind.USER_CHAT,
        direction=Direction.IN,
        counterpart_id="owner:alice",
        counterpart_role=CounterpartRole.USER,
    )
    # Invariant 2 — never empty.
    assert meta
    # All five required fields present.
    assert set(meta.keys()) == {
        "event_id", "kind", "direction",
        "counterpart_id", "counterpart_role",
    }
    assert meta["kind"] == "user_chat"
    assert meta["direction"] == "in"
    assert meta["counterpart_id"] == "owner:alice"
    assert meta["counterpart_role"] == "user"
    assert isinstance(meta["event_id"], str) and meta["event_id"]


def test_make_event_metadata_includes_linked_when_present() -> None:
    meta = make_event_metadata(
        kind=Kind.TOOL_RUN_SUMMARY,
        direction=Direction.IN,
        counterpart_id="sub-1",
        counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
        linked_event_id="evt-parent",
    )
    assert meta["linked_event_id"] == "evt-parent"


def test_make_event_metadata_omits_linked_when_absent() -> None:
    meta = make_event_metadata(
        kind=Kind.REFLECTION,
        direction=Direction.INTERNAL,
        counterpart_id="self",
        counterpart_role=CounterpartRole.SELF,
    )
    assert "linked_event_id" not in meta


def test_make_event_metadata_carries_payload_as_defensive_copy() -> None:
    payload = {"trigger_category": "first_idle"}
    meta = make_event_metadata(
        kind=Kind.REFLECTION,
        direction=Direction.INTERNAL,
        counterpart_id="self",
        counterpart_role=CounterpartRole.SELF,
        payload=payload,
    )
    assert meta["payload"] == {"trigger_category": "first_idle"}
    # Defensive copy — caller's later mutation must not leak in.
    payload["trigger_category"] = "long_idle"
    assert meta["payload"] == {"trigger_category": "first_idle"}


def test_make_event_metadata_omits_empty_payload() -> None:
    meta = make_event_metadata(
        kind=Kind.DM,
        direction=Direction.OUT,
        counterpart_id="peer-1",
        counterpart_role=CounterpartRole.PEER,
        payload=None,
    )
    assert "payload" not in meta


# ─────────────────────────────────────────────────────────────────
# make_event_metadata — extra fields + reserved-key guard
# ─────────────────────────────────────────────────────────────────


def test_make_event_metadata_appends_extra_fields() -> None:
    meta = make_event_metadata(
        kind=Kind.TASK_REQUEST,
        direction=Direction.OUT,
        counterpart_id="sub-1",
        counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
        extra={"task_id": "T-42"},
    )
    assert meta["task_id"] == "T-42"


def test_make_event_metadata_rejects_reserved_keys_in_extra() -> None:
    """Cycle 20260430_2 invariant — the schema's reserved namespace is
    not a hint, it's a contract. Caller code that tries to override
    `kind` / `event_id` / etc. via *extra* gets a hard failure so
    the regression cannot ship silently."""
    with pytest.raises(ValueError):
        make_event_metadata(
            kind=Kind.DM,
            direction=Direction.OUT,
            counterpart_id="peer-1",
            counterpart_role=CounterpartRole.PEER,
            extra={"event_id": "shadow"},
        )


# ─────────────────────────────────────────────────────────────────
# parse_event_metadata — round-trip + legacy fallback
# ─────────────────────────────────────────────────────────────────


def test_parse_round_trips_every_field() -> None:
    meta = make_event_metadata(
        kind=Kind.TOOL_RUN_SUMMARY,
        direction=Direction.IN,
        counterpart_id="sub-1",
        counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
        linked_event_id="evt-parent",
        payload={"files_written": ["a.md"]},
    )
    view = parse_event_metadata(meta)
    assert isinstance(view, InteractionEventView)
    assert view.event_id == meta["event_id"]
    assert view.kind == "tool_run_summary"
    assert view.direction == "in"
    assert view.counterpart_id == "sub-1"
    assert view.counterpart_role == "paired_subworker"
    assert view.linked_event_id == "evt-parent"
    assert view.payload == {"files_written": ["a.md"]}


def test_parse_returns_none_on_legacy_metadata() -> None:
    """Pre-unification STM lines must not crash the parser. The
    backwards-compat contract: missing schema → None, callers fall
    through to legacy handling."""
    assert parse_event_metadata(None) is None
    assert parse_event_metadata({}) is None
    assert parse_event_metadata({"role": "user"}) is None  # legacy-only field


def test_parse_returns_none_on_partial_schema() -> None:
    # Missing one required field → still treated as legacy.
    partial = {
        "event_id": "abc",
        "kind": "user_chat",
        "direction": "in",
        "counterpart_id": "owner:alice",
        # counterpart_role missing
    }
    assert parse_event_metadata(partial) is None


def test_parse_view_payload_safe_when_absent() -> None:
    meta = make_event_metadata(
        kind=Kind.USER_CHAT,
        direction=Direction.OUT,
        counterpart_id="owner:alice",
        counterpart_role=CounterpartRole.USER,
    )
    view = parse_event_metadata(meta)
    assert view is not None
    # Optional — absent payload shows up as an empty dict, not KeyError.
    assert view.payload == {}
    assert view.linked_event_id is None
