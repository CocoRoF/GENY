"""Thin async client for a connected geny-avatar instance.

geny-avatar exposes a live config API (`PUT /api/config/keys` — no restart) for
its image-gen provider keys. Geny pushes provider keys here so the avatar stays
in sync with Geny's central LLMCredentialsConfig. Connection is env-only,
mirroring the GAPT client: ``GENY_AVATAR_BASE_URL`` (empty = integration off).
The base URL must include the avatar's reverse-proxy prefix if any (e.g.
``http://geny-avatar:3000/avatar-editor``); the client appends ``/api/...``.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class AvatarClient:
    """One instance per process is fine (httpx pools per call here)."""

    def __init__(self, *, base_url: Optional[str] = None, timeout_s: Optional[float] = None) -> None:
        raw = base_url if base_url is not None else os.getenv("GENY_AVATAR_BASE_URL", "")
        self.base_url = (raw or "").rstrip("/")
        self._timeout = float(timeout_s if timeout_s is not None else os.getenv("GENY_AVATAR_TIMEOUT_S", "30"))

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    async def _request(self, method: str, path: str, *, json: Any = None) -> Any:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.request(method, f"{self.base_url}{path}", json=json)
            resp.raise_for_status()
            try:
                return resp.json()
            except Exception:  # noqa: BLE001 — non-JSON body
                return resp.text

    async def put_config_keys(
        self,
        *,
        set_: Optional[Dict[str, str]] = None,
        clear: Optional[List[str]] = None,
    ) -> Any:
        """Upsert (``set``) / remove (``clear``) keys by the avatar's provider id
        (e.g. ``openai``/``gemini``/``falai``/``replicate``)."""
        body: Dict[str, Any] = {}
        if set_:
            body["set"] = set_
        if clear:
            body["clear"] = clear
        return await self._request("PUT", "/api/config/keys", json=body)

    async def get_config_keys(self) -> Any:
        return await self._request("GET", "/api/config/keys")

    async def health(self) -> bool:
        try:
            await self._request("GET", "/api/config/keys")
            return True
        except Exception:  # noqa: BLE001
            return False


_client: Optional[AvatarClient] = None


def get_avatar_client() -> AvatarClient:
    global _client
    if _client is None:
        _client = AvatarClient()
    return _client
