"""Geny-side Environment system.

Bridges geny-executor v0.20.0's :class:`EnvironmentManifest` persistence
model into Geny. Port of :mod:`geny_executor_web.app.services.environment_service`
with identical JSON layout on disk — existing web-created environments
can be copied into Geny's storage root without conversion.

Phase 3 scope: service + exceptions only. Routers (controller layer) and
the `env_id` / `memory_config` extension on `POST /api/agents` arrive in
separate PRs (see ``plan/06_rollout_and_verification.md`` entries 6-8).
"""

from typing import Optional

from service.environment.exceptions import (
    EnvironmentNotFoundError,
    StageValidationError,
)
from service.environment.service import EnvironmentService

__all__ = [
    "EnvironmentNotFoundError",
    "EnvironmentService",
    "StageValidationError",
    "get_environment_service",
    "set_environment_service",
]


# ── Singleton accessor (Phase 9.9.2) ──────────────────────────────
#
# `main.py` constructs a single ``EnvironmentService`` at boot and
# wires it into ``AgentSessionManager`` + ``app.state``. Service-layer
# code (e.g. ``AgentSession._load_permission_host_selection``) needs
# to reach the same instance without taking a FastAPI ``Request`` —
# this module-level slot bridges the gap.

_INSTANCE: Optional[EnvironmentService] = None


def set_environment_service(svc: Optional[EnvironmentService]) -> None:
    """Register the process-wide ``EnvironmentService`` instance. Call
    once at boot from ``main.py`` after constructing the service.
    Passing ``None`` clears the slot (used by tests)."""
    global _INSTANCE
    _INSTANCE = svc


def get_environment_service() -> Optional[EnvironmentService]:
    """Return the registered ``EnvironmentService`` instance, or
    ``None`` if boot hasn't reached the wiring step yet (e.g. during
    early-startup imports / tests)."""
    return _INSTANCE
