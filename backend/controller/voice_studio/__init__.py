"""
Voice Studio HTTP layer (``/api/voice-studio/*``).

Sub-routers (synthesis_preview, languages) are gathered into a single
``router`` exported from this package; ``backend/main.py`` registers it
with one ``app.include_router(voice_studio_router)`` call, mirroring
how :mod:`controller.tts_controller` does it.

The legacy ``/api/tts/*`` contract in :mod:`controller.tts_controller`
is **frozen** — voice-studio additions live exclusively under the new
prefix.
"""

from fastapi import APIRouter

from .history import router as _history_router
from .languages import router as _languages_router
from .save_as_ref import router as _save_as_ref_router
from .synthesis_preview import router as _synth_router

router = APIRouter(prefix="/api/voice-studio", tags=["voice-studio"])
router.include_router(_synth_router)
router.include_router(_history_router)
router.include_router(_save_as_ref_router)
router.include_router(_languages_router)
