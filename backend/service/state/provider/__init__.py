"""Storage-layer providers for ``CreatureState`` (PR-X3-2).

The pipeline wrapper (PR-X3-3 Registry) talks to storage only through the
``CreatureStateProvider`` Protocol — concrete implementations live here:

- ``InMemoryCreatureStateProvider`` — test/fixture impl, dict-backed.
- ``SqliteCreatureStateProvider``   — file-backed sqlite3 MVP.
"""

from __future__ import annotations

from .in_memory import InMemoryCreatureStateProvider
from .interface import (
    RECENT_EVENTS_MAX,
    CreatureStateProvider,
    StateConflictError,
)
from .mutate import apply_mutations
from .sqlite_creature import SqliteCreatureStateProvider

__all__ = [
    "CreatureStateProvider",
    "InMemoryCreatureStateProvider",
    "RECENT_EVENTS_MAX",
    "SqliteCreatureStateProvider",
    "StateConflictError",
    "apply_mutations",
]
