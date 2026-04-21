"""``CreatureState`` + substructures — the durable per-character game state."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

from .mood import MoodVector

SCHEMA_VERSION = 1


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Vitals:
    """Physical upkeep stats — decay over time, restored by interactions."""

    hunger: float = 50.0       # 0=sated, 100=starving
    energy: float = 80.0       # 0=exhausted, 100=peak
    stress: float = 20.0       # 0=calm, 100=extreme stress
    cleanliness: float = 80.0  # 0=filthy, 100=spotless


@dataclass
class Bond:
    """Relationship stats — accumulate long term; do not decay."""

    affection: float = 0.0
    trust: float = 0.0
    familiarity: float = 0.0
    dependency: float = 0.0


@dataclass
class Progression:
    """Long-term growth state."""

    age_days: int = 0
    life_stage: str = "infant"    # infant / child / teen / adult
    xp: int = 0
    milestones: List[str] = field(default_factory=list)
    manifest_id: str = "base"


@dataclass
class CreatureState:
    # Identity
    character_id: str
    owner_user_id: str

    # Mutable game state
    vitals: Vitals = field(default_factory=Vitals)
    bond: Bond = field(default_factory=Bond)
    mood: MoodVector = field(default_factory=MoodVector)
    progression: Progression = field(default_factory=Progression)

    # Timestamps / event stream
    last_tick_at: datetime = field(default_factory=_utcnow)
    last_interaction_at: Optional[datetime] = None
    recent_events: List[str] = field(default_factory=list)

    # Schema version for migrations
    schema_version: int = SCHEMA_VERSION
