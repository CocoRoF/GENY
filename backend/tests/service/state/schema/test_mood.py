"""MoodVector contract (cycle 20260421_9 PR-X3-1).

Covers default values, EMA blending, dominant-emotion lookup, and
alpha-range validation.
"""

from __future__ import annotations

import pytest

from backend.service.state.schema.mood import MoodVector


def test_default_mood_is_neutral() -> None:
    m = MoodVector()
    assert m.joy == 0.0
    assert m.sadness == 0.0
    assert m.anger == 0.0
    assert m.fear == 0.0
    assert m.excitement == 0.0
    assert m.calm == 0.5  # neutral baseline


def test_keys_and_as_dict_roundtrip() -> None:
    m = MoodVector(joy=0.3, calm=0.6)
    assert set(MoodVector.keys()) == {
        "joy",
        "sadness",
        "anger",
        "fear",
        "calm",
        "excitement",
    }
    d = m.as_dict()
    assert d["joy"] == pytest.approx(0.3)
    assert d["calm"] == pytest.approx(0.6)
    # unset keys default correctly
    assert d["sadness"] == 0.0


def test_ema_alpha_zero_keeps_self() -> None:
    a = MoodVector(joy=1.0, calm=0.0)
    b = MoodVector(joy=0.0, calm=1.0)
    out = a.ema(b, alpha=0.0)
    assert out.joy == pytest.approx(1.0)
    assert out.calm == pytest.approx(0.0)


def test_ema_alpha_one_returns_other() -> None:
    a = MoodVector(joy=1.0, calm=0.0)
    b = MoodVector(joy=0.0, calm=1.0)
    out = a.ema(b, alpha=1.0)
    assert out.joy == pytest.approx(0.0)
    assert out.calm == pytest.approx(1.0)


def test_ema_blends_each_axis() -> None:
    a = MoodVector(joy=1.0, sadness=0.0)
    b = MoodVector(joy=0.0, sadness=1.0)
    out = a.ema(b, alpha=0.25)
    # new = 0.75 * a + 0.25 * b
    assert out.joy == pytest.approx(0.75)
    assert out.sadness == pytest.approx(0.25)


def test_ema_rejects_alpha_out_of_range() -> None:
    a = MoodVector()
    with pytest.raises(ValueError):
        a.ema(MoodVector(), alpha=-0.1)
    with pytest.raises(ValueError):
        a.ema(MoodVector(), alpha=1.5)


def test_ema_returns_new_instance() -> None:
    a = MoodVector(joy=0.2)
    b = MoodVector(joy=0.8)
    out = a.ema(b, alpha=0.5)
    assert out is not a
    assert out is not b
    # a itself unchanged
    assert a.joy == pytest.approx(0.2)


def test_dominant_returns_strongest_above_threshold() -> None:
    m = MoodVector(joy=0.7, sadness=0.2, anger=0.1)
    assert m.dominant() == "joy"


def test_dominant_calm_when_all_below_threshold() -> None:
    m = MoodVector(joy=0.05, sadness=0.05, calm=0.8)
    # calm is NOT considered a basic emotion for dominance — fallback
    assert m.dominant() == "calm"


def test_dominant_threshold_boundary() -> None:
    # exactly at threshold counts as below (strictly >)
    m = MoodVector(joy=0.15)
    assert m.dominant(threshold=0.15) == "calm"
    m2 = MoodVector(joy=0.16)
    assert m2.dominant(threshold=0.15) == "joy"


def test_dominant_picks_first_on_tie() -> None:
    # tie between joy and sadness — lookup order (joy first) wins.
    m = MoodVector(joy=0.5, sadness=0.5)
    assert m.dominant() == "joy"
