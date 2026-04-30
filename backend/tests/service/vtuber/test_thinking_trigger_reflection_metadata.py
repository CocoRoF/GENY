"""Cycle 20260430_2 A5 — reflection InteractionEvent metadata.

Pins ``ThinkingTriggerService._build_reflection_metadata`` — the
helper that turns a trigger prompt into an explicit
``source_metadata`` dict the recipient invoke (= the VTuber itself,
self-prompted) records on its STM.
"""

from __future__ import annotations

import pytest

from service.vtuber.thinking_trigger import ThinkingTriggerService


def test_reflection_metadata_for_thinking_trigger_with_category() -> None:
    prompt = (
        "[THINKING_TRIGGER:first_idle] "
        "[autonomous_signal: idle_detected] A pause settles."
    )
    meta = ThinkingTriggerService._build_reflection_metadata(prompt)
    assert meta is not None
    assert meta["kind"] == "reflection"
    assert meta["direction"] == "internal"
    assert meta["counterpart_id"] == "self"
    assert meta["counterpart_role"] == "self"
    assert meta["payload"] == {
        "trigger_family": "thinking_trigger",
        "trigger_category": "first_idle",
    }


def test_reflection_metadata_for_activity_trigger_without_category() -> None:
    """Older ACTIVITY_TRIGGER prompts don't carry ":category" —
    should still record cleanly with the family as the category."""
    prompt = (
        "[ACTIVITY_TRIGGER] Check what's trending right now! ..."
    )
    meta = ThinkingTriggerService._build_reflection_metadata(prompt)
    assert meta is not None
    assert meta["payload"]["trigger_family"] == "activity_trigger"
    assert meta["payload"]["trigger_category"] == "activity_trigger"


def test_reflection_metadata_for_activity_trigger_with_category() -> None:
    prompt = "[ACTIVITY_TRIGGER:web_surf] Curiosity strikes."
    meta = ThinkingTriggerService._build_reflection_metadata(prompt)
    assert meta is not None
    assert meta["payload"]["trigger_family"] == "activity_trigger"
    assert meta["payload"]["trigger_category"] == "web_surf"


def test_reflection_metadata_for_thinking_trigger_sub_worker_working() -> None:
    """Sub-worker-busy variant — exercises P1-4 cooldown wiring path."""
    prompt = (
        "[THINKING_TRIGGER:sub_worker_working] "
        "[autonomous_signal: linked_agent_busy] My linked Sub-Worker is busy."
    )
    meta = ThinkingTriggerService._build_reflection_metadata(prompt)
    assert meta is not None
    assert meta["payload"]["trigger_category"] == "sub_worker_working"


def test_reflection_metadata_returns_none_for_unrecognised_prompt() -> None:
    """An ad-hoc / future prompt shape returns None so the recipient
    falls through to the parser fallback (which itself noops on
    internal_trigger). Either way no inject — that's the invariant."""
    assert (
        ThinkingTriggerService._build_reflection_metadata("ordinary user message")
        is None
    )
    assert (
        ThinkingTriggerService._build_reflection_metadata("[CUSTOM_TAG] hello")
        is None
    )
