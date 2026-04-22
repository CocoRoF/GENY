"""JSON roundtrip for ``CreatureState`` (cycle 20260421_9 PR-X3-2)."""

from __future__ import annotations

from datetime import datetime, timezone

from service.state.provider.serialize import dumps, from_dict, loads
from service.state.schema.creature_state import (
    SCHEMA_VERSION,
    Bond,
    CreatureState,
    Progression,
    Vitals,
)
from service.state.schema.mood import MoodVector


def test_dumps_produces_valid_json_string() -> None:
    s = CreatureState(character_id="c", owner_user_id="u")
    blob = dumps(s)
    assert isinstance(blob, str)
    # Non-empty JSON.
    assert blob.startswith("{") and blob.endswith("}")


def test_roundtrip_preserves_defaults() -> None:
    s = CreatureState(character_id="c", owner_user_id="u")
    out = loads(dumps(s))
    assert out.character_id == "c"
    assert out.owner_user_id == "u"
    assert out.vitals.hunger == s.vitals.hunger
    assert out.bond.affection == s.bond.affection
    assert out.mood.calm == s.mood.calm
    assert out.progression.life_stage == s.progression.life_stage
    assert out.schema_version == SCHEMA_VERSION


def test_roundtrip_preserves_modified_state() -> None:
    s = CreatureState(
        character_id="c",
        owner_user_id="u",
        vitals=Vitals(hunger=25.0, energy=40.0),
        bond=Bond(affection=3.0, trust=1.5),
        mood=MoodVector(joy=0.7, calm=0.2),
        progression=Progression(
            age_days=5, life_stage="child", xp=120,
            milestones=["first_meet"], manifest_id="child_default",
        ),
        last_interaction_at=datetime(2026, 4, 21, 12, tzinfo=timezone.utc),
        recent_events=["played", "fed"],
    )
    out = loads(dumps(s))
    assert out.vitals.hunger == 25.0
    assert out.bond.affection == 3.0
    assert out.mood.joy == 0.7
    assert out.progression.milestones == ["first_meet"]
    assert out.recent_events == ["played", "fed"]
    assert out.last_interaction_at == datetime(2026, 4, 21, 12, tzinfo=timezone.utc)


def test_datetime_preserved_as_utc() -> None:
    s = CreatureState(
        character_id="c",
        owner_user_id="u",
        last_tick_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    out = loads(dumps(s))
    assert out.last_tick_at.tzinfo is not None
    assert out.last_tick_at == datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_from_dict_missing_last_tick_at_raises() -> None:
    try:
        from_dict({"character_id": "c", "owner_user_id": "u"})
    except ValueError:
        return
    raise AssertionError("missing last_tick_at should raise ValueError")


def test_from_dict_accepts_partial_substructures() -> None:
    raw = {
        "character_id": "c",
        "owner_user_id": "u",
        "vitals": {"hunger": 10.0},  # partial — rest defaults
        "last_tick_at": datetime(2026, 4, 21, tzinfo=timezone.utc).isoformat(),
    }
    out = from_dict(raw)
    assert out.vitals.hunger == 10.0
    # unsupplied defaults still applied
    assert out.vitals.energy == 80.0
