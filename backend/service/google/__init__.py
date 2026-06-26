"""Google Workspace integration (OAuth device flow + runtime token).

The native Gmail/Calendar/Drive/Tasks tools live in geny-executor and read their
OAuth token from ``ctx.extras['google']``; Geny owns the OAuth (device flow),
token storage (GoogleConfig), refresh, and the per-session injection here.
"""

from service.google.oauth import (
    disconnect,
    google_tool_extras,
    has_client,
    is_connected,
    poll_once,
    refresh_access_token,
    start_device_flow,
)

__all__ = [
    "start_device_flow",
    "poll_once",
    "refresh_access_token",
    "google_tool_extras",
    "is_connected",
    "has_client",
    "disconnect",
]
