"""Geny-specific settings sections + loader install (PR-B.3.5)."""

import asyncio

from service.settings.install import install_geny_settings
from service.settings.sections import PresetSection, VTuberSection

# Serializes read-modify-write of ~/.geny/settings.json across the three
# controllers that patch it (framework_settings / hook / permission).
# Without it two concurrent PATCHes to different sections both read the
# old file and the second write clobbers the first section's change
# (audit H1). Async lock is enough — all writers are FastAPI coroutines
# on the one event loop; the file swap itself is already atomic.
SETTINGS_WRITE_LOCK = asyncio.Lock()

__all__ = [
    "PresetSection",
    "VTuberSection",
    "install_geny_settings",
    "SETTINGS_WRITE_LOCK",
]
