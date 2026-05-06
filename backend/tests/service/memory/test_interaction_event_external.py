"""External agent (blog:<uid>) classification 분기 테스트.

Phase 2 (BLOG_AGENT_DELEGATION_PLAN.md) — 외부 (out-of-process) AI agent 와의
양방향 위임이 EXTERNAL_TASK_* / EXTERNAL_AGENT 로 정확히 분류되는지.
"""
from __future__ import annotations

from types import SimpleNamespace

from service.memory.interaction_event import (
    CounterpartRole,
    Direction,
    Kind,
    dm_kind_for_recipient,
    make_event_metadata,
)


def _agent(*, session_id="x", session_type=None, linked=None):
    return SimpleNamespace(
        _session_id=session_id,
        _session_type=session_type,
        _linked_session_id=linked,
    )


def test_external_result_envelope_overrides_pairing() -> None:
    """body 가 EXTERNAL_TASK_RESULT 로 시작하면 sender 정보와 무관하게 분류."""
    body = "[EXTERNAL_TASK_RESULT]\nFrom: blog:abc\nTask: t1\n\nbody"
    kind, role = dm_kind_for_recipient(
        sender_agent=None,         # external sender → AgentSession 없음
        recorder_agent=_agent(session_id="g1", session_type="vtuber"),
        body=body,
    )
    assert kind == Kind.EXTERNAL_TASK_RESULT
    assert role == CounterpartRole.EXTERNAL_AGENT


def test_external_request_envelope() -> None:
    body = "[EXTERNAL_TASK_REQUEST]\nFrom: g1\n\nbody"
    kind, role = dm_kind_for_recipient(
        sender_agent=None,
        recorder_agent=_agent(session_id="x"),
        body=body,
    )
    assert kind == Kind.EXTERNAL_TASK_REQUEST
    assert role == CounterpartRole.EXTERNAL_AGENT


def test_subworker_result_still_works_for_paired_pair() -> None:
    """기존 PAIRED_* 분기를 외부 prefix 가 망치지 않는지 회귀."""
    sub = _agent(session_id="sub-id", session_type="sub", linked="vtuber-id")
    vtuber = _agent(session_id="vtuber-id", session_type="vtuber", linked="sub-id")
    body = "[SUB_WORKER_RESULT]\nbody"
    kind, role = dm_kind_for_recipient(
        sender_agent=sub,
        recorder_agent=vtuber,
        body=body,
    )
    assert kind == Kind.TASK_RESULT
    assert role == CounterpartRole.PAIRED_SUBWORKER


def test_make_event_metadata_with_external_enums_round_trips() -> None:
    md = make_event_metadata(
        kind=Kind.EXTERNAL_TASK_RESULT,
        direction=Direction.IN,
        counterpart_id="blog:abc-uid",
        counterpart_role=CounterpartRole.EXTERNAL_AGENT,
    )
    assert md["kind"] == "external_task_result"
    assert md["counterpart_role"] == "external_agent"
    assert md["counterpart_id"] == "blog:abc-uid"
    assert md["direction"] == "in"
    assert "event_id" in md


def test_geny_tools_outgoing_classifier_external_target() -> None:
    """sender 측 분류기 — target 이 blog:* prefix 또는 None 이면 EXTERNAL."""
    from tools.built_in.geny_tools import _classify_outgoing_dm

    sender = _agent(session_id="g1", session_type="vtuber", linked=None)
    kind, role = _classify_outgoing_dm(
        sender_agent=sender,
        target_agent=None,
        target_session_id="blog:abc-uid",
        body="hi",
    )
    assert kind == Kind.DM
    assert role == CounterpartRole.EXTERNAL_AGENT


def test_geny_tools_outgoing_classifier_external_request_envelope() -> None:
    from tools.built_in.geny_tools import _classify_outgoing_dm

    sender = _agent(session_id="g1", session_type="vtuber")
    kind, role = _classify_outgoing_dm(
        sender_agent=sender,
        target_agent=None,
        target_session_id="blog:abc",
        body="[EXTERNAL_TASK_REQUEST]\nbody",
    )
    assert kind == Kind.EXTERNAL_TASK_REQUEST
    assert role == CounterpartRole.EXTERNAL_AGENT
