"""Geny-side Trigger Preset system.

Bundles the CRUD service, schemas, and default-manifest factory used by
the new "트리거 관리" tab on the environments page. A *trigger preset*
is a swappable bundle of timing knobs, phase brackets, weighted
event tables, and prompt catalogs that can be attached per VTuber
session — when no preset is attached the runtime falls back to the
historical hardcoded ladder via :func:`defaults.default_manifest`.

Singleton wiring mirrors :mod:`service.environment`: ``main.py``
instantiates one :class:`TriggerPresetService` at boot, registers it on
``app.state``, and bridges it to service-layer code (notably
:mod:`service.vtuber.thinking_trigger`) via the module-level slot
below.
"""

from typing import Optional

from service.trigger_preset.exceptions import (
    TriggerPresetNotFoundError,
    TriggerPresetValidationError,
)
from service.trigger_preset.service import TriggerPresetService

__all__ = [
    "TriggerPresetService",
    "TriggerPresetNotFoundError",
    "TriggerPresetValidationError",
    "get_trigger_preset_service",
    "set_trigger_preset_service",
]


_INSTANCE: Optional[TriggerPresetService] = None


def set_trigger_preset_service(svc: Optional[TriggerPresetService]) -> None:
    """Register the process-wide :class:`TriggerPresetService` instance.

    Called once at boot from ``main.py``; passing ``None`` clears the
    slot (used by tests). Service-layer code reaches the same instance
    via :func:`get_trigger_preset_service` rather than threading the
    FastAPI ``Request`` through every callsite.
    """
    global _INSTANCE
    _INSTANCE = svc


def get_trigger_preset_service() -> Optional[TriggerPresetService]:
    return _INSTANCE
