"""Atlassian — Jira + Confluence credentials for the native atlassian tools.

geny-executor ships an optional ``atlassian`` tool family (jira_search /
jira_issue / jira_create / jira_update / jira_comment / jira_transition /
confluence_search / confluence_page / confluence_write). This config is the
single source for its credentials: at session build ``agent_session`` hands
``{base_url, email, api_token, confluence_base_url}`` to the executor via
``ToolContext.extras["atlassian"]``.

Auth modes (the executor picks automatically):
  * **Cloud** — ``email`` + API token → Basic ``email:token``
    (token from https://id.atlassian.com/manage-profile/security/api-tokens).
  * **Server / Data Center** — leave ``email`` empty, put a Personal Access
    Token in ``api_token`` → ``Bearer`` auth.

When ``enabled`` AND ``base_url`` + ``api_token`` are set, Geny satisfies
``feature:atlassian_connected`` (``tool_config_gate``) and the whole family
appears; otherwise it is never registered (progressive disclosure). The token
lives only in the config store and the per-session extras — never in the
prompt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class AtlassianConfig(BaseConfig):
    """Atlassian site + credential for the jira_* / confluence_* tools."""

    #: Site root, e.g. ``https://acme.atlassian.net`` (Cloud) or the Jira
    #: base URL of a Server/DC install.
    base_url: str = ""
    #: Atlassian account email — Cloud only (Basic auth pair). Empty on
    #: Server/DC → the executor switches to Bearer PAT auth.
    email: str = ""
    #: Cloud API token or Server/DC Personal Access Token.
    api_token: str = ""
    #: Server/DC only: Confluence base URL when it is NOT ``{base_url}/wiki``.
    confluence_base_url: str = ""
    #: Master switch — off hides the tools even when credentials exist.
    enabled: bool = True

    def is_connected(self) -> bool:
        """Gate condition for ``feature:atlassian_connected``."""
        return bool(
            self.enabled and self.base_url.strip() and self.api_token.strip()
        )

    def executor_extras(self) -> Dict[str, str]:
        """The ``ToolContext.extras['atlassian']`` credential bag."""
        return {
            "base_url": self.base_url.strip(),
            "email": self.email.strip(),
            "api_token": self.api_token.strip(),
            "confluence_base_url": self.confluence_base_url.strip(),
        }

    @classmethod
    def get_default_instance(cls) -> "AtlassianConfig":
        return cls()

    @classmethod
    def get_config_name(cls) -> str:
        return "atlassian"

    @classmethod
    def get_display_name(cls) -> str:
        return "Atlassian (Jira · Confluence)"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Connect a Jira/Confluence site. With a site URL + API token the "
            "agents get native jira_* / confluence_* tools (search, read, "
            "create, update, comment, transition, write pages)."
        )

    @classmethod
    def get_category(cls) -> str:
        return "tools"

    @classmethod
    def get_icon(cls) -> str:
        return "kanban"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "Atlassian (Jira · Confluence)",
                "description": (
                    "Jira/Confluence 사이트를 연결합니다. 사이트 URL + API 토큰만 "
                    "넣으면 에이전트가 jira_*/confluence_* 네이티브 도구(검색·조회·"
                    "생성·수정·코멘트·상태 전환·페이지 작성)를 쓸 수 있어요."
                ),
                "fields": {
                    "base_url": {
                        "label": "사이트 URL",
                        "description": "예: https://acme.atlassian.net (Cloud) 또는 사내 Jira 주소.",
                    },
                    "email": {
                        "label": "계정 이메일 (Cloud)",
                        "description": "Cloud는 이메일+API 토큰 조합. Server/DC(PAT)는 비워두세요.",
                    },
                    "api_token": {
                        "label": "API 토큰 / PAT",
                        "description": "Cloud: id.atlassian.com에서 발급한 API 토큰. Server/DC: 개인 액세스 토큰.",
                    },
                    "confluence_base_url": {
                        "label": "Confluence URL (선택)",
                        "description": "Server/DC에서 Confluence가 {사이트URL}/wiki가 아닐 때만 입력.",
                    },
                    "enabled": {
                        "label": "활성화",
                        "description": "끄면 자격증명이 있어도 도구가 숨겨집니다.",
                    },
                },
            }
        }

    @classmethod
    def get_setup_guide(cls) -> Dict[str, str]:
        return {
            "ko": (
                "# Atlassian 연결\n\n"
                "**Atlassian Cloud** (`*.atlassian.net`)\n\n"
                "1. <https://id.atlassian.com/manage-profile/security/api-tokens>에서 "
                "API 토큰을 발급합니다.\n"
                "2. `사이트 URL`(예: `https://acme.atlassian.net`), `계정 이메일`, "
                "`API 토큰`을 입력하고 저장합니다.\n\n"
                "**Jira Server / Data Center**\n\n"
                "1. Jira 프로필 → 개인 액세스 토큰(PAT)을 발급합니다.\n"
                "2. `사이트 URL`과 `API 토큰`만 입력하고 **이메일은 비워둡니다** "
                "(Bearer 인증으로 전환).\n"
                "3. Confluence가 별도 주소면 `Confluence URL`을 추가로 입력합니다.\n\n"
                "> 저장하면 새 세션부터 jira_*/confluence_* 도구가 나타납니다. "
                "토큰 권한(프로젝트/스페이스 접근)이 곧 에이전트의 권한입니다.\n"
            ),
            "en": (
                "# Connect Atlassian\n\n"
                "**Cloud** — create an API token at "
                "<https://id.atlassian.com/manage-profile/security/api-tokens>, then "
                "fill Site URL + Email + API Token.\n\n"
                "**Server / Data Center** — create a Personal Access Token, fill Site "
                "URL + API Token and **leave Email empty** (switches to Bearer auth). "
                "Add the Confluence URL only when it isn't `{site}/wiki`.\n\n"
                "New sessions then expose the jira_* / confluence_* tools; the "
                "token's permissions are the agent's permissions.\n"
            ),
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="enabled",
                field_type=FieldType.BOOLEAN,
                label="Enabled",
                description="Master switch — off hides the tools even with credentials set.",
                default=True,
                group="connection",
            ),
            ConfigField(
                name="base_url",
                field_type=FieldType.URL,
                label="Site URL",
                description="e.g. https://acme.atlassian.net (Cloud) or your Jira base URL.",
                placeholder="https://acme.atlassian.net",
                group="connection",
            ),
            ConfigField(
                name="email",
                field_type=FieldType.EMAIL,
                label="Account Email (Cloud)",
                description="Cloud pairs email + API token. Leave empty for Server/DC PAT.",
                placeholder="me@company.com",
                group="credentials",
            ),
            ConfigField(
                name="api_token",
                field_type=FieldType.PASSWORD,
                label="API Token / PAT",
                description="Cloud API token (id.atlassian.com) or a Server/DC personal access token.",
                placeholder="ATATT...",
                group="credentials",
                secure=True,
            ),
            ConfigField(
                name="confluence_base_url",
                field_type=FieldType.URL,
                label="Confluence URL (optional)",
                description="Server/DC only — when Confluence is not {Site URL}/wiki.",
                placeholder="https://confluence.company.com",
                group="connection",
            ),
        ]
