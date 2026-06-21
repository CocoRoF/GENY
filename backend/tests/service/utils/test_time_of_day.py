"""Time-of-day labelling + trigger time-context anchor (KST-correct)."""

from __future__ import annotations

import pytest

from service.utils.utils import (
    now_kst,
    time_context_phrase,
    time_of_day_key,
    time_of_day_label,
)


@pytest.mark.parametrize(
    "hour,key",
    [
        (0, "dawn"),
        (3, "dawn"),
        (5, "dawn"),
        (6, "morning"),
        (9, "morning"),
        (11, "morning"),
        (12, "afternoon"),
        (17, "afternoon"),
        (18, "evening"),
        (21, "evening"),
        (22, "night"),
        (23, "night"),
    ],
)
def test_time_of_day_key_buckets(hour, key):
    assert time_of_day_key(hour) == key


def test_morning_is_not_evening():
    """The reported bug: 09:xx must read as 아침/morning, never 저녁/evening."""
    dt = now_kst().replace(hour=9, minute=51)
    assert time_of_day_label(dt, "ko") == "아침"
    assert time_of_day_label(dt, "en") == "morning"
    assert "아침" in time_context_phrase(dt, "ko")
    assert "저녁" not in time_context_phrase(dt, "ko")


def test_dawn_distinct_from_night():
    dawn = now_kst().replace(hour=3, minute=0)
    night = now_kst().replace(hour=23, minute=0)
    assert time_of_day_label(dawn, "ko") == "새벽"
    assert time_of_day_label(night, "ko") == "밤"


def test_phrase_shape():
    dt = now_kst().replace(hour=20, minute=30)
    ko = time_context_phrase(dt, "ko")
    assert "저녁" in ko and "20:30" in ko  # e.g. "일요일 저녁, 20:30 KST"


def test_render_prompt_includes_time_context():
    from service.trigger_preset.schemas import TriggerCategory, render_prompt

    cat = TriggerCategory(
        id="loneliness",
        label="외로움",
        kind="thinking",
        weight=1.0,
        autonomous_signal="lonely",
        prompt_refs=[],
    )
    out = render_prompt(cat, "say something", time_context="일요일 아침, 09:51 KST")
    assert "[time_context: 일요일 아침, 09:51 KST]" in out
    assert "[THINKING_TRIGGER:loneliness]" in out
    # omitted when not supplied
    assert "time_context" not in render_prompt(cat, "hi")
