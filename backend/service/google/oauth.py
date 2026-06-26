"""Google OAuth 2.0 Device Flow + token runtime.

Device flow (RFC 8628) is used so connecting works on ANY deployment — no public
https redirect URI required. UX: the frontend calls ``start_device_flow`` → shows
the user a short code + a URL → the user approves on google.com → the frontend
polls ``poll_once`` until connected. The ``refresh_token`` is then stored in
:class:`GoogleConfig`; :func:`google_tool_extras` mints a fresh access token per
session for the executor's ``google_*`` tools.

Sync ``httpx`` calls (short, admin-initiated). No google-api SDK dependency.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, Optional

logger = getLogger(__name__)

_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

# Scopes covering the native google_* tools (Gmail / Calendar / Drive / Tasks) +
# identity. Broad but matched to the tool surface; the user consents once.
SCOPES = " ".join([
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/tasks",
])


def _cfg():
    from service.config import get_config_manager
    from service.config.sub_config.general.google_config import GoogleConfig

    return get_config_manager().load_config(GoogleConfig)


def _save(values: Dict[str, Any]) -> None:
    from service.config import get_config_manager

    get_config_manager().update_config("google", values)


def has_client() -> bool:
    try:
        return _cfg().has_client()
    except Exception:  # noqa: BLE001
        return False


def is_connected() -> bool:
    try:
        return _cfg().is_connected()
    except Exception:  # noqa: BLE001
        return False


def start_device_flow() -> Dict[str, Any]:
    """Begin the device flow. Returns user_code / verification_url / device_code /
    interval / expires_in. Raises ValueError if the OAuth client isn't set."""
    import httpx

    cfg = _cfg()
    if not cfg.has_client():
        raise ValueError("Google OAuth client_id/client_secret not set")
    with httpx.Client(timeout=20) as c:
        r = c.post(_DEVICE_CODE_URL, data={"client_id": cfg.client_id, "scope": SCOPES})
        r.raise_for_status()
        d = r.json()
    return {
        "device_code": d["device_code"],
        "user_code": d["user_code"],
        "verification_url": d.get("verification_url") or d.get("verification_uri"),
        "interval": d.get("interval", 5),
        "expires_in": d.get("expires_in", 1800),
    }


def poll_once(device_code: str) -> Dict[str, Any]:
    """Poll the token endpoint once. Returns {status: connected|pending|error}.
    On 'connected' the refresh_token is saved to GoogleConfig."""
    import httpx

    cfg = _cfg()
    if not cfg.has_client():
        return {"status": "error", "error": "client_not_set"}
    with httpx.Client(timeout=20) as c:
        r = c.post(_TOKEN_URL, data={
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
            "device_code": device_code,
            "grant_type": _DEVICE_GRANT,
        })
    if r.status_code == 200:
        tok = r.json()
        rt = tok.get("refresh_token")
        if rt:
            _save({"refresh_token": rt})
            logger.info("Google connected — refresh_token stored")
            return {"status": "connected"}
        return {"status": "error", "error": "no_refresh_token"}
    # Non-200: pending / slow_down / denied / expired
    err = ""
    try:
        err = r.json().get("error", "")
    except Exception:  # noqa: BLE001
        err = f"http_{r.status_code}"
    if err in ("authorization_pending", "slow_down"):
        return {"status": "pending"}
    return {"status": "error", "error": err or "unknown"}


def refresh_access_token() -> Optional[str]:
    """Mint a fresh access token from the stored refresh token, or None."""
    import httpx

    cfg = _cfg()
    if not cfg.is_connected():
        return None
    try:
        with httpx.Client(timeout=20) as c:
            r = c.post(_TOKEN_URL, data={
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "refresh_token": cfg.refresh_token,
                "grant_type": "refresh_token",
            })
        if r.status_code == 200:
            return r.json().get("access_token")
        logger.warning("Google token refresh failed: %s %s", r.status_code, r.text[:160])
    except Exception as e:  # noqa: BLE001
        logger.warning("Google token refresh error: %s", e)
    return None


def google_tool_extras() -> Optional[Dict[str, Any]]:
    """The ``ctx.extras['google']`` payload for a session, or None if not connected.

    Includes a freshly-minted access_token plus the refresh_token + client creds so
    the executor tool can self-refresh on a mid-session 401."""
    cfg = _cfg()
    if not cfg.is_connected():
        return None
    access = refresh_access_token()
    if not access:
        return None
    return {
        "access_token": access,
        "refresh_token": cfg.refresh_token,
        "client_id": cfg.client_id,
        "client_secret": cfg.client_secret,
    }


def disconnect() -> None:
    """Clear the stored refresh token (keeps the client_id/secret)."""
    _save({"refresh_token": ""})
    logger.info("Google disconnected — refresh_token cleared")
