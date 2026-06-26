"""Google Workspace integration (OAuth authorization-code flow + runtime token).

The native Gmail/Calendar/Drive/Tasks tools live in geny-executor and read their
OAuth token from ``ctx.extras['google']``; Geny owns the OAuth (authorization-code
flow), token storage (GoogleConfig), refresh, and the per-session injection here.
"""

from service.google.oauth import (
    build_auth_url,
    disconnect,
    exchange_code,
    google_tool_extras,
    has_client,
    is_connected,
    refresh_access_token,
)

__all__ = [
    "build_auth_url",
    "exchange_code",
    "refresh_access_token",
    "google_tool_extras",
    "is_connected",
    "has_client",
    "disconnect",
]
