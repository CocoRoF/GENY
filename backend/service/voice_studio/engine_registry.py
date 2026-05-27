"""
Voice Studio engine registry helpers.

Surfaces the ClassVar metadata on every registered ``TTSEngine`` plus a
parallel ``is_available`` probe so the Settings page Compatibility
Matrix can render in one round-trip. Also owns the ``default_engine``
selection — persisted in :mod:`settings_store` AND mirrored into
``tts_general_config.provider`` so the legacy chat path picks up the
same choice without a separate UI.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass, field
from logging import getLogger
from typing import List

from .settings_store import get_settings_store

logger = getLogger(__name__)

_DEFAULT_ENGINE_KEY = "default_engine"


@dataclass(slots=True)
class EngineCard:
    id: str
    display_name: str
    sample_rate: int
    supported_languages: List[str]
    gpu_compat: List[str]
    supports_voice_design: bool
    supports_clone: bool
    supports_emotion_vector: bool
    license: str
    available: bool
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


async def _probe(name: str, engine) -> EngineCard:  # type: ignore[no-untyped-def]
    try:
        ok, reason = await engine.is_available()
    except Exception as e:
        ok, reason = False, f"{type(e).__name__}: {e}"
    return EngineCard(
        id=name,
        display_name=getattr(engine, "display_name", name),
        sample_rate=int(getattr(engine, "sample_rate", 24000)),
        supported_languages=list(getattr(engine, "supported_languages", ["multi"])),
        gpu_compat=list(getattr(engine, "gpu_compat", ("cpu",))),
        supports_voice_design=bool(getattr(engine, "supports_voice_design", False)),
        supports_clone=bool(getattr(engine, "supports_clone", False)),
        supports_emotion_vector=bool(getattr(engine, "supports_emotion_vector", False)),
        license=str(getattr(engine, "license", "")),
        available=bool(ok),
        reason=str(reason),
    )


async def list_engine_cards() -> List[EngineCard]:
    from service.vtuber.tts.tts_service import get_tts_service

    svc = get_tts_service()
    items = list(svc._engines.items())  # type: ignore[attr-defined]
    return list(await asyncio.gather(*[_probe(n, e) for n, e in items]))


def get_default_engine_name() -> str:
    """Resolution order: settings_store → tts_general_config.provider → edge_tts."""
    try:
        store = get_settings_store()
        persisted = store.get(_DEFAULT_ENGINE_KEY)
        if isinstance(persisted, str) and persisted:
            return persisted
    except Exception:
        logger.debug("voice-studio default engine: settings_store unavailable", exc_info=True)

    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.tts.tts_general_config import TTSGeneralConfig

        general = get_config_manager().load_config(TTSGeneralConfig)
        if general.provider:
            return general.provider
    except Exception:
        logger.debug("voice-studio default engine: tts_general unavailable", exc_info=True)

    return "edge_tts"


def set_default_engine_name(name: str) -> None:
    """Mirror the choice into both stores so chat + studio stay in sync."""
    store = get_settings_store()
    store.set(_DEFAULT_ENGINE_KEY, name)
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.tts.tts_general_config import TTSGeneralConfig

        mgr = get_config_manager()
        cfg = mgr.load_config(TTSGeneralConfig)
        if cfg.provider != name:
            cfg.provider = name
            mgr.save_config(cfg)
    except Exception:
        logger.warning(
            "voice-studio default engine: failed mirroring into tts_general",
            exc_info=True,
        )
