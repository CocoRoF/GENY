"""
``GET /api/voice-studio/languages`` — proxy for the upstream OmniVoice
``GET /languages`` endpoint.

OmniVoice serves 600+ language entries. We cache the response in-process
for 1 hour to avoid a round-trip on every page load; downstream callers
should treat the language list as effectively static.
"""

from __future__ import annotations

import time
from logging import getLogger
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter()
logger = getLogger(__name__)

_CACHE_TTL_S = 3600.0  # 1 hour
_cache: Dict[str, Any] = {"at": 0.0, "data": None}


@router.get("/languages")
async def list_languages() -> Dict[str, Any]:
    """Proxy + cache. Returns the upstream payload verbatim plus a count.

    Shape (best-effort — passes upstream through unchanged):

    .. code-block:: json

        {
          "languages": [{"code": "ko", "name": "Korean"}, ...],
          "count": 646,
          "cached_at": "2026-05-27T07:00:00Z"
        }
    """
    now = time.monotonic()
    if _cache["data"] is not None and (now - _cache["at"]) < _CACHE_TTL_S:
        return _cache["data"]

    from service.config.manager import get_config_manager
    from service.config.sub_config.tts.omnivoice_config import OmniVoiceConfig

    config = get_config_manager().load_config(OmniVoiceConfig)
    api_url = config.api_url.rstrip("/")
    timeout = max(float(config.timeout_seconds or 0.0), 10.0)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{api_url}/languages")
            resp.raise_for_status()
            body = resp.json()
    except httpx.HTTPError as e:
        logger.warning("voice-studio /languages upstream error: %s", e)
        raise HTTPException(status_code=502, detail=f"OmniVoice /languages unreachable: {e}") from e

    # Upstream shape can vary slightly across server versions. Normalise:
    # - list of strings           → [{"code": s, "name": s}, ...]
    # - list of {"code","name"}   → kept as-is
    # - {"languages": [...]}       → unwrap
    raw: List[Any] = body.get("languages", body) if isinstance(body, dict) else body
    languages: List[Dict[str, str]] = []
    for item in raw:
        if isinstance(item, str):
            languages.append({"code": item, "name": item})
        elif isinstance(item, dict):
            code = str(item.get("code") or item.get("iso") or item.get("name") or "")
            name = str(item.get("name") or item.get("code") or code)
            if code:
                languages.append({"code": code, "name": name})

    data = {
        "languages": languages,
        "count": len(languages),
        "cached_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _cache["data"] = data
    _cache["at"] = now
    return data
