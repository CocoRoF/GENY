"""Google OAuth 2.0 Authorization Code Flow + token runtime.

The authorization-code flow (with ``access_type=offline`` + ``prompt=consent`` to
get a refresh token) is used because Google's **Device Flow does NOT support
Workspace scopes** (Gmail/Calendar/Drive/Tasks → ``invalid_scope``). This needs a
public https redirect URI — fine now that the deployment has a public domain.

UX: the frontend calls ``build_auth_url`` (passing its own ``window.location.origin
+ /api/google/callback`` as the redirect URI) → opens the returned Google URL in a
popup → the user approves → Google redirects to ``/api/google/callback`` →
``exchange_code`` swaps the code for tokens and stores the ``refresh_token`` in
:class:`GoogleConfig`. :func:`google_tool_extras` then mints a fresh access token
per session for the executor's ``google_*`` tools.

Sync ``httpx`` calls (short, admin-initiated). No google-api SDK dependency.
"""

from __future__ import annotations

import secrets
from logging import getLogger
from typing import Any, Dict, Optional
from urllib.parse import urlencode

logger = getLogger(__name__)

_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"

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


def build_auth_url(redirect_uri: str) -> Dict[str, Any]:
    """Build the Google consent URL for the authorization-code flow. Stores a
    fresh CSRF ``state`` + the ``redirect_uri`` (the token exchange must echo the
    exact same redirect_uri). Raises ValueError if the OAuth client isn't set."""
    cfg = _cfg()
    if not cfg.has_client():
        raise ValueError("Google OAuth client_id/client_secret not set")
    if not redirect_uri:
        raise ValueError("redirect_uri required")
    state = secrets.token_urlsafe(24)
    _save({"oauth_state": state, "oauth_redirect_uri": redirect_uri})
    params = {
        "client_id": cfg.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",   # → refresh_token
        "prompt": "consent",        # force a refresh_token even on re-consent
        "include_granted_scopes": "true",
        "state": state,
    }
    return {"auth_url": f"{_AUTH_URL}?{urlencode(params)}", "redirect_uri": redirect_uri}


def exchange_code(code: str, state: str) -> Dict[str, Any]:
    """Exchange an authorization code for tokens. Verifies the CSRF state, uses
    the stored redirect_uri, and saves the refresh_token. Returns
    {status: connected|error}. Clears the transient state regardless."""
    import httpx

    cfg = _cfg()
    if not cfg.has_client():
        return {"status": "error", "error": "client_not_set"}
    if not state or state != (cfg.oauth_state or ""):
        return {"status": "error", "error": "state_mismatch"}
    redirect_uri = cfg.oauth_redirect_uri or ""
    try:
        with httpx.Client(timeout=20) as c:
            r = c.post(_TOKEN_URL, data={
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            })
    finally:
        _save({"oauth_state": ""})  # single-use
    if r.status_code == 200:
        tok = r.json()
        rt = tok.get("refresh_token")
        if rt:
            _save({"refresh_token": rt})
            logger.info("Google connected — refresh_token stored")
            return {"status": "connected"}
        # No refresh_token: usually a prior consent without prompt=consent.
        return {"status": "error", "error": "no_refresh_token"}
    err = ""
    try:
        body = r.json()
        err = body.get("error_description") or body.get("error", "")
    except Exception:  # noqa: BLE001
        err = f"http_{r.status_code}"
    logger.warning("Google code exchange failed: %s %s", r.status_code, err)
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
    _save({"refresh_token": "", "oauth_state": "", "oauth_redirect_uri": ""})
    logger.info("Google disconnected — refresh_token cleared")
