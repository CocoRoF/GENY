"""JSON ↔ ``CreatureState`` roundtrip helpers.

Providers serialize state to a JSON blob column. Dataclass ``asdict``
covers the positive direction; the negative direction rebuilds nested
dataclasses from dicts and parses ISO-8601 timestamps back to tz-aware
``datetime``. Everything other than schema fields round-trips as-is.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime
from typing import Any, Dict

from ..schema.creature_state import (
    SCHEMA_VERSION,
    Bond,
    CreatureState,
    Progression,
    Vitals,
)
from ..schema.mood import MoodVector


def _serialize_default(obj: Any) -> Any:
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"not JSON-serializable: {type(obj).__name__}")


def dumps(state: CreatureState) -> str:
    return json.dumps(asdict(state), default=_serialize_default, ensure_ascii=False)


def _parse_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def loads(blob: str) -> CreatureState:
    raw = json.loads(blob)
    return from_dict(raw)


def from_dict(raw: Dict[str, Any]) -> CreatureState:
    """Reconstruct ``CreatureState`` from a plain dict (used in tests, too)."""
    vitals = Vitals(**raw.get("vitals", {}))
    bond = Bond(**raw.get("bond", {}))
    mood = MoodVector(**raw.get("mood", {}))
    progression = Progression(**raw.get("progression", {}))
    last_tick_at = _parse_dt(raw.get("last_tick_at"))
    if last_tick_at is None:
        raise ValueError("creature_state blob missing last_tick_at")
    return CreatureState(
        character_id=raw["character_id"],
        owner_user_id=raw["owner_user_id"],
        vitals=vitals,
        bond=bond,
        mood=mood,
        progression=progression,
        last_tick_at=last_tick_at,
        last_interaction_at=_parse_dt(raw.get("last_interaction_at")),
        recent_events=list(raw.get("recent_events", [])),
        schema_version=int(raw.get("schema_version", SCHEMA_VERSION)),
    )
