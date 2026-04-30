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
    dm_kind_for_recipient,
    infer_input_metadata,
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


# ─────────────────────────────────────────────────────────────────
# Cycle 20260430_2 A3 — dm_kind_for_recipient
# ─────────────────────────────────────────────────────────────────


class _FakeAgent:
    """Tiny stand-in mirroring the attributes the helper inspects."""

    def __init__(
        self,
        session_id: str,
        *,
        session_type: str = "",
        linked_session_id: str = "",
    ) -> None:
        self._session_id = session_id
        self._session_type = session_type
        self._linked_session_id = linked_session_id


def test_recipient_paired_sub_receives_task_request_from_vtuber() -> None:
    """Sub-Worker getting a plain DM from its bound VTuber sees it as
    a TASK_REQUEST (the same kind the sender stamped on its own STM)."""
    sender = _FakeAgent("vtuber-1", session_type="vtuber", linked_session_id="sub-1")
    recorder = _FakeAgent("sub-1", session_type="sub", linked_session_id="vtuber-1")
    kind, role = dm_kind_for_recipient(
        sender_agent=sender, recorder_agent=recorder, body="please write notes.md",
    )
    assert kind == Kind.TASK_REQUEST
    assert role == CounterpartRole.PAIRED_VTUBER


def test_recipient_paired_vtuber_receives_task_result_on_subworker_marker() -> None:
    sender = _FakeAgent("sub-1", session_type="sub", linked_session_id="vtuber-1")
    recorder = _FakeAgent("vtuber-1", session_type="vtuber", linked_session_id="sub-1")
    kind, role = dm_kind_for_recipient(
        sender_agent=sender, recorder_agent=recorder,
        body="[SUB_WORKER_RESULT]\nstatus: ok\nsummary: done",
    )
    assert kind == Kind.TASK_RESULT
    assert role == CounterpartRole.PAIRED_SUBWORKER


def test_recipient_paired_vtuber_receives_plain_dm_when_no_marker() -> None:
    sender = _FakeAgent("sub-1", session_type="sub", linked_session_id="vtuber-1")
    recorder = _FakeAgent("vtuber-1", session_type="vtuber", linked_session_id="sub-1")
    kind, role = dm_kind_for_recipient(
        sender_agent=sender, recorder_agent=recorder, body="quick note",
    )
    assert kind == Kind.DM
    assert role == CounterpartRole.PAIRED_SUBWORKER


def test_recipient_unpaired_pair_falls_back_to_peer_dm() -> None:
    """If the sender's _linked_session_id doesn't point at the
    recorder, the relationship isn't paired — collapse to PEER + DM
    even when both happen to be vtuber/sub instances."""
    sender = _FakeAgent("vtuber-2", session_type="vtuber", linked_session_id="sub-9")
    recorder = _FakeAgent("sub-1", session_type="sub", linked_session_id="vtuber-1")
    kind, role = dm_kind_for_recipient(
        sender_agent=sender, recorder_agent=recorder, body="hi",
    )
    assert kind == Kind.DM
    assert role == CounterpartRole.PEER


def test_recipient_unknown_session_type_collapses_to_peer_dm() -> None:
    sender = _FakeAgent("x", session_type="", linked_session_id="")
    recorder = _FakeAgent("sub-1", session_type="sub", linked_session_id="x")
    kind, role = dm_kind_for_recipient(
        sender_agent=sender, recorder_agent=recorder, body="hi",
    )
    # paired link exists but sender_type is unknown — still PEER.
    assert kind == Kind.DM
    assert role == CounterpartRole.PEER


# ─────────────────────────────────────────────────────────────────
# Cycle 20260430_2 A3 — infer_input_metadata (parser fallback)
# ─────────────────────────────────────────────────────────────────


class _FakeManager:
    def __init__(self, agents):
        self._agents = agents

    def get_agent(self, sid):
        return self._agents.get(sid)

    def resolve_session(self, sid):
        return self._agents.get(sid)


@pytest.fixture
def parser_world(monkeypatch):
    sub = _FakeAgent("sub-1", session_type="sub", linked_session_id="vtuber-1")
    vtuber = _FakeAgent("vtuber-1", session_type="vtuber", linked_session_id="sub-1")
    manager = _FakeManager({"sub-1": sub, "vtuber-1": vtuber})
    monkeypatch.setattr(
        "service.executor.get_agent_session_manager",
        lambda: manager,
        raising=False,
    )
    return {"manager": manager, "sub": sub, "vtuber": vtuber}


def test_infer_skips_non_dm_role(parser_world) -> None:
    """Only assistant_dm goes through the parser. user / assistant /
    internal_trigger return None so A5 / A6 fill them with explicit
    source_metadata."""
    assert infer_input_metadata(
        input_text="hello", recorder_agent=parser_world["vtuber"], role="user",
    ) is None
    assert infer_input_metadata(
        input_text="[THINKING_TRIGGER:first_idle] something",
        recorder_agent=parser_world["vtuber"], role="internal_trigger",
    ) is None


def test_infer_picks_up_dm_trigger_prompt(parser_world) -> None:
    """The well-known [SYSTEM] header from `_trigger_dm_response`
    parses cleanly: sender_session_id is the canonical id, body
    starts at the [DM from ...]: payload."""
    prompt = (
        "[SYSTEM] You received a direct message from Sub-Worker (session: sub-1). "
        "Read the message below and take appropriate action.\n\n"
        "[DM from Sub-Worker]: [SUB_WORKER_RESULT]\nstatus: ok"
    )
    meta = infer_input_metadata(
        input_text=prompt,
        recorder_agent=parser_world["vtuber"],
        role="assistant_dm",
    )
    assert meta is not None
    assert meta["kind"] == "task_result"
    assert meta["direction"] == "in"
    assert meta["counterpart_id"] == "sub-1"
    assert meta["counterpart_role"] == "paired_subworker"


def test_infer_falls_back_to_peer_when_sender_unknown(parser_world) -> None:
    """If the parser sees the [SYSTEM] header but the sender_session_id
    can't be resolved (deleted session, name-only id, etc.) the helper
    still emits a minimal PEER + DM so the metadata invariant holds."""
    prompt = (
        "[SYSTEM] You received a direct message from Ghost (session: ghost-id). "
        "blah blah\n\n[DM from Ghost]: hello?"
    )
    meta = infer_input_metadata(
        input_text=prompt,
        recorder_agent=parser_world["vtuber"],
        role="assistant_dm",
    )
    assert meta is not None
    assert meta["kind"] == "dm"
    assert meta["counterpart_id"] == "ghost-id"
    assert meta["counterpart_role"] == "peer"


def test_infer_handles_inbox_wrapper(parser_world) -> None:
    """The drain path wraps the inbox content as `[INBOX from name]\\n…`.
    No session id available, so the sender_name lands as a soft id
    and counterpart_role falls to PEER."""
    prompt = "[INBOX from Sub-Worker]\n[SUB_WORKER_RESULT] ..."
    meta = infer_input_metadata(
        input_text=prompt,
        recorder_agent=parser_world["vtuber"],
        role="assistant_dm",
    )
    assert meta is not None
    assert meta["kind"] == "dm"
    assert meta["direction"] == "in"
    assert meta["counterpart_id"] == "Sub-Worker"
    assert meta["counterpart_role"] == "peer"


def test_infer_returns_none_when_dm_role_but_unknown_shape(
    parser_world,
) -> None:
    """assistant_dm role without one of the recognised prefixes →
    parser gives up. Caller's record_message will write content with
    no metadata, which is still valid (legacy fallback)."""
    meta = infer_input_metadata(
        input_text="[some custom marker] hello",
        recorder_agent=parser_world["vtuber"],
        role="assistant_dm",
    )
    assert meta is None
