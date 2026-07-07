"""Single source of truth for provider API keys — the LLM & Provider panel.

Every Geny service that needs a cloud-provider key resolves it HERE, not
from scattered configs or bare env vars:

    from service.config.credentials import resolve_provider_key
    key = resolve_provider_key("openai")

Resolution: ``LLMCredentialsConfig`` (what the LLM & Provider settings
section edits) first, process env as legacy fallback. The two normally
agree — ``env_sync`` mirrors config saves into ``os.environ`` — but the
config is canonical: a value pasted in settings must win over a stale
``.env`` seed.

``validate_provider_key`` adds a LIVE auth probe (one cheap models-list
request, cached per key value) so a rejected key shows as "rejected" in
the health panel instead of a green "configured" that fails downstream.
"""

from __future__ import annotations

import hashlib
import os
from logging import getLogger
from typing import Dict, Optional, Tuple

logger = getLogger(__name__)

# provider → (LLMCredentialsConfig field, canonical env var)
PROVIDER_KEY_FIELDS: Dict[str, Tuple[str, str]] = {
    "anthropic": ("anthropic_api_key", "ANTHROPIC_API_KEY"),
    "openai": ("openai_api_key", "OPENAI_API_KEY"),
    "google": ("google_api_key", "GOOGLE_API_KEY"),
}

_PROBE_TIMEOUT_S = 8.0

# (provider, sha1(key)) → (ok, detail). Only definitive verdicts are
# cached; transient probe failures re-probe next time.
_VALIDATION_CACHE: Dict[Tuple[str, str], Tuple[bool, str]] = {}


def resolve_provider_key(provider: str) -> str:
    """The provider's API key as configured in LLM & Provider settings
    (env fallback for pre-config deployments). '' when unset."""
    spec = PROVIDER_KEY_FIELDS.get(provider)
    if spec is None:
        return ""
    field, env_var = spec
    try:
        from service.config.manager import get_config_manager
        from service.config.sub_config.general.llm_credentials_config import (
            LLMCredentialsConfig,
        )

        creds = get_config_manager().load_config(LLMCredentialsConfig)
        key = (getattr(creds, field, "") or "").strip()
        if key:
            return key
    except Exception:  # noqa: BLE001 — config layer down → env fallback
        logger.debug("resolve_provider_key: config unavailable", exc_info=True)
    return (os.environ.get(env_var) or "").strip()


async def validate_provider_key(
    provider: str,
    key: Optional[str] = None,
    *,
    force: bool = False,
) -> Tuple[Optional[bool], str]:
    """Live-validate *key* (resolved from settings when omitted) against
    the provider's API. Returns ``(True, detail)`` verified, ``(False,
    detail)`` rejected, ``(None, detail)`` unknown (no key / transient
    probe failure — never treated as rejection)."""
    if key is None:
        key = resolve_provider_key(provider)
    key = (key or "").strip()
    if not key:
        return None, "no key configured"
    if provider not in PROVIDER_KEY_FIELDS:
        return None, f"no validator for provider {provider!r}"

    cache_key = (provider, hashlib.sha1(key.encode("utf-8")).hexdigest())
    if not force:
        cached = _VALIDATION_CACHE.get(cache_key)
        if cached is not None:
            return cached

    verdict = await _probe(provider, key)
    if verdict[0] is not None:
        _VALIDATION_CACHE[cache_key] = verdict  # definitive only
    return verdict


async def _probe(provider: str, key: str) -> Tuple[Optional[bool], str]:
    try:
        import httpx
    except ImportError:
        return None, "httpx unavailable"

    if provider == "openai":
        url, headers = (
            "https://api.openai.com/v1/models",
            {"Authorization": f"Bearer {key}"},
        )
    elif provider == "anthropic":
        url, headers = (
            "https://api.anthropic.com/v1/models",
            {"x-api-key": key, "anthropic-version": "2023-06-01"},
        )
    else:  # google
        url, headers = (
            "https://generativelanguage.googleapis.com/v1beta/models"
            f"?key={key}&pageSize=1",
            {},
        )

    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_S) as client:
            res = await client.get(url, headers=headers)
    except Exception as exc:  # noqa: BLE001 — network trouble ≠ bad key
        return None, f"probe failed: {type(exc).__name__}"

    if res.status_code in (401, 403):
        return False, f"rejected (HTTP {res.status_code})"
    if 200 <= res.status_code < 300:
        return True, "verified"
    # 429/5xx — the key reached the provider but no auth verdict.
    return None, f"unverified (HTTP {res.status_code})"
