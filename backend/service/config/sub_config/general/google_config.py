"""Google Workspace configuration.

Holds the user's Google OAuth client (client_id / client_secret — from their Google
Cloud **"Web application"** OAuth client) plus the obtained ``refresh_token``.
Connection uses the OAuth 2.0 **Authorization Code flow** with a redirect URI on the
deployment's public domain — required because Google's Device Flow does NOT support
Workspace scopes (Gmail/Calendar/Drive/Tasks). See ``service.google.oauth``.

Hidden from the generic settings auto-form (``is_user_visible() == False``); a
dedicated "Google" card + ``controller/google_controller.py`` manage the client
credentials and the connect/disconnect flow. The OAuth scopes cover Gmail /
Calendar / Drive / Tasks so the native ``google_*`` executor tools work once
connected.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class GoogleConfig(BaseConfig):
    """Google OAuth client + token."""

    client_id: str = ""
    client_secret: str = ""
    # Obtained via the authorization-code connect; not user-typed.
    refresh_token: str = ""
    # Transient per-connect state (CSRF) + the redirect URI used to start the
    # flow — the token exchange must echo the exact same redirect_uri.
    oauth_state: str = ""
    oauth_redirect_uri: str = ""

    @classmethod
    def get_config_name(cls) -> str:
        return "google"

    @classmethod
    def get_display_name(cls) -> str:
        return "Google Workspace"

    @classmethod
    def get_description(cls) -> str:
        return "Google OAuth client + connection for Gmail / Calendar / Drive / Tasks tools."

    @classmethod
    def get_category(cls) -> str:
        return "tools"

    @classmethod
    def get_icon(cls) -> str:
        return "google"

    @classmethod
    def is_user_visible(cls) -> bool:
        # Managed by the dedicated Google card + OAuth controller, not the
        # generic auto-form (the refresh_token is set by the OAuth flow).
        return False

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="client_id",
                field_type=FieldType.PASSWORD,
                label="OAuth Client ID",
                description="Google Cloud OAuth client id (Web application)",
                group="google",
                secure=True,
            ),
            ConfigField(
                name="client_secret",
                field_type=FieldType.PASSWORD,
                label="OAuth Client Secret",
                description="Google Cloud OAuth client secret",
                group="google",
                secure=True,
            ),
            ConfigField(
                name="refresh_token",
                field_type=FieldType.PASSWORD,
                label="Refresh Token",
                description="Set automatically after connecting via the OAuth flow",
                group="google",
                secure=True,
            ),
        ]

    # Convenience accessors -------------------------------------------------
    def has_client(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def is_connected(self) -> bool:
        return bool(self.client_id and self.client_secret and self.refresh_token)
