"""Propagate Geny's provider API keys to connected sister services.

Geny is the source of truth for LLM/image-gen provider API keys (its
``LLMCredentialsConfig``). When a key changes — or on an explicit "Sync now" —
push it to the services that consume the SAME key but configure it independently:

  * GAPT   → ``POST /_gapt/api/llm-backends/api-keys/{provider}``  (SYSTEM vault)
  * avatar → ``PUT  {avatar}/api/config/keys``  ``{set: {<id>: value}}``

Best-effort + connection-gated: a target that isn't wired (no base URL) or is
unreachable is skipped, never blocking the Geny config save. Only the genuinely
SHARED provider keys are here; Claude OAuth/setup-token and infra secrets are
hard-excluded (never synced — rotation/topology hazards).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Callable, Dict

from service.config.sub_config.general.env_utils import env_sync

logger = logging.getLogger(__name__)

# canonical Geny env key → per-target provider identifier.
# GAPT provider names: anthropic/openai/google (_PROVIDER_TO_VAULT_KEY).
# avatar provider ids: openai/gemini/falai/replicate (apiKeyProviders.ts).
_SYNC_MAP: Dict[str, Dict[str, str]] = {
    "ANTHROPIC_API_KEY": {"gapt": "anthropic"},
    "OPENAI_API_KEY": {"gapt": "openai", "avatar": "openai"},
    "GOOGLE_API_KEY": {"gapt": "google", "avatar": "gemini"},
    "FAL_KEY": {"avatar": "falai"},
    "REPLICATE_API_TOKEN": {"avatar": "replicate"},
}


def synced_env(env_key: str) -> Callable[[Any, Any], None]:
    """``apply_change`` that does ``env_sync(env_key)`` AND, for a shared key,
    schedules a fire-and-forget push to the sister services. Drop-in replacement
    for ``env_sync`` on the provider-key fields of LLMCredentialsConfig."""
    base = env_sync(env_key)

    def _apply(old_value: Any, new_value: Any) -> None:
        base(old_value, new_value)
        if env_key in _SYNC_MAP:
            _schedule_push(env_key, new_value)

    return _apply


def _schedule_push(env_key: str, value: Any) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug("provider_key_sync: no running loop; skip push for %s", env_key)
        return
    loop.create_task(push_provider_key(env_key, value))


async def push_provider_key(env_key: str, value: Any) -> Dict[str, str]:
    """Push ONE key to all its targets. An empty value clears the target
    (the user explicitly removed it in Geny)."""
    targets = _SYNC_MAP.get(env_key) or {}
    val = "" if value is None else str(value)
    results: Dict[str, str] = {}
    if "gapt" in targets:
        results["gapt"] = await _push_gapt(targets["gapt"], val)
    if "avatar" in targets:
        results["avatar"] = await _push_avatar(targets["avatar"], val)
    return results


async def _push_gapt(provider: str, value: str) -> str:
    try:
        from service.gapt.client import get_gapt_client

        gc = get_gapt_client()
        if not gc.configured:
            return "skipped: gapt not configured"
        path = f"/_gapt/api/llm-backends/api-keys/{provider}"
        if len(value) < 8:  # GAPT requires >=8; empty/short ⇒ remove
            await gc.delete(path)
            return "deleted"
        await gc.post(path, json={"api_key": value})
        return "pushed"
    except Exception as exc:  # noqa: BLE001 — best effort
        logger.warning("provider_key_sync: gapt push %s failed: %s", provider, exc)
        return f"error: {exc}"


async def _push_avatar(avatar_id: str, value: str) -> str:
    try:
        from service.avatar.client import get_avatar_client

        ac = get_avatar_client()
        if not ac.configured:
            return "skipped: avatar not configured"
        if not value:
            await ac.put_config_keys(clear=[avatar_id])
            return "cleared"
        await ac.put_config_keys(set_={avatar_id: value})
        return "pushed"
    except Exception as exc:  # noqa: BLE001 — best effort
        logger.warning("provider_key_sync: avatar push %s failed: %s", avatar_id, exc)
        return f"error: {exc}"


async def sync_all() -> Dict[str, Any]:
    """Push ALL currently-set provider keys (the explicit 'Sync now' action).

    Reads live values from ``os.environ`` (config apply_change keeps them current,
    incl. at boot). Skips empty keys — 'Sync now' propagates what Geny HAS; it
    does NOT mass-clear a target's locally-set keys.
    """
    out: Dict[str, Any] = {}
    for env_key in _SYNC_MAP:
        val = os.environ.get(env_key, "")
        if not val:
            out[env_key] = "skipped: empty"
            continue
        out[env_key] = await push_provider_key(env_key, val)
    return out


def sync_targets_status() -> Dict[str, Dict[str, Any]]:
    """Lightweight (no network) view of which sync targets are wired."""
    status: Dict[str, Dict[str, Any]] = {}
    try:
        from service.gapt.client import get_gapt_client

        status["gapt"] = {"configured": bool(get_gapt_client().configured)}
    except Exception:  # noqa: BLE001
        status["gapt"] = {"configured": False}
    try:
        from service.avatar.client import get_avatar_client

        status["avatar"] = {"configured": bool(get_avatar_client().configured)}
    except Exception:  # noqa: BLE001
        status["avatar"] = {"configured": False}
    return status
