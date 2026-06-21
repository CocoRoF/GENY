"""Web Search — global default backend + keys for the web-search tools.

geny-executor's web search supports DuckDuckGo (zero-config), Brave, Tavily and
SearXNG. This is the **global default**: values sync to the env vars the
executor reads (``GENY_WEBSEARCH_BACKEND`` / ``BRAVE_SEARCH_API_KEY`` /
``TAVILY_API_KEY`` / ``SEARXNG_URL``), so every session falls back to them.

Precedence (highest first): a tool call's explicit ``backend`` → the
environment's **Tool Settings** (``ctx.extras["web_search"]``) → this global
config (env vars) → DuckDuckGo. So per-environment Tool Settings override this.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


@register_config
@dataclass
class WebSearchConfig(BaseConfig):
    """Global web-search backend + credentials."""

    backend: str = "ddg"
    brave_api_key: str = ""
    tavily_api_key: str = ""
    searxng_url: str = ""

    _ENV_MAP = {
        "backend": "GENY_WEBSEARCH_BACKEND",
        "brave_api_key": "BRAVE_SEARCH_API_KEY",
        "tavily_api_key": "TAVILY_API_KEY",
        "searxng_url": "SEARXNG_URL",
    }

    @classmethod
    def get_default_instance(cls) -> "WebSearchConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "web_search"

    @classmethod
    def get_display_name(cls) -> str:
        return "Web Search"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Global default search engine for the web-search tools. DuckDuckGo "
            "needs no key; Brave / Tavily / SearXNG give better results but need "
            "a key (or URL). An environment's Tool Settings override this."
        )

    @classmethod
    def get_category(cls) -> str:
        return "tools"

    @classmethod
    def get_icon(cls) -> str:
        return "search"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "웹 검색",
                "description": (
                    "웹 검색 도구가 쓸 글로벌 기본 검색 엔진. DuckDuckGo는 키 없이 "
                    "동작하고, Brave/Tavily/SearXNG는 결과가 더 좋지만 키(또는 URL)가 "
                    "필요해요. 환경별 Tool Settings가 이 값을 덮어씁니다."
                ),
                "fields": {
                    "backend": {
                        "label": "검색 백엔드",
                        "description": "DuckDuckGo는 키 불필요. 나머지는 아래 키/URL 필요.",
                    },
                    "brave_api_key": {
                        "label": "Brave API 키",
                        "description": "Brave 백엔드 전용. api.search.brave.com에서 발급.",
                    },
                    "tavily_api_key": {
                        "label": "Tavily API 키",
                        "description": "Tavily 백엔드 전용. app.tavily.com에서 발급.",
                    },
                    "searxng_url": {
                        "label": "SearXNG URL",
                        "description": "SearXNG 백엔드 전용. 본인 인스턴스 기본 URL.",
                    },
                },
            }
        }

    @classmethod
    def get_setup_guide(cls) -> Dict[str, str]:
        return {
            "ko": (
                "# 웹 검색 백엔드 (글로벌 기본값)\n\n"
                "여기서 정한 값은 **모든 환경의 기본 검색 엔진**이 됩니다. 특정 환경만 "
                "다르게 쓰려면 그 환경의 **Tool Settings**에서 덮어쓰면 돼요(우선).\n\n"
                "- **DuckDuckGo** — 기본값, 키 불필요.\n"
                "- **Brave** — `Brave API 키` 입력(<https://api.search.brave.com>, 무료 등급).\n"
                "- **Tavily** — `Tavily API 키` 입력(<https://app.tavily.com>, LLM 친화적).\n"
                "- **SearXNG** — 자체 호스팅 URL 입력(JSON 출력 허용).\n\n"
                "> 저장하면 즉시 env 로 동기화돼 새 세션부터 적용됩니다.\n"
            ),
            "en": (
                "# Web search backend (global default)\n\n"
                "Sets the default search engine for **every** environment. Override "
                "per environment in its **Tool Settings** (takes precedence).\n\n"
                "- **DuckDuckGo** — default, no key.\n"
                "- **Brave / Tavily** — paste an API key.\n"
                "- **SearXNG** — your self-hosted instance URL.\n"
            ),
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="backend",
                field_type=FieldType.SELECT,
                label="Search Backend",
                description="DuckDuckGo needs no key. Others need a key/URL below.",
                default="ddg",
                options=[
                    {"value": "ddg", "label": "DuckDuckGo (no key)"},
                    {"value": "brave", "label": "Brave Search (API key)"},
                    {"value": "tavily", "label": "Tavily (API key)"},
                    {"value": "searxng", "label": "SearXNG (self-hosted URL)"},
                ],
                group="backend",
                apply_change=env_sync("GENY_WEBSEARCH_BACKEND"),
            ),
            ConfigField(
                name="brave_api_key",
                field_type=FieldType.PASSWORD,
                label="Brave API Key",
                description="Only for the Brave backend. From api.search.brave.com.",
                placeholder="BSA...",
                group="credentials",
                secure=True,
                apply_change=env_sync("BRAVE_SEARCH_API_KEY"),
            ),
            ConfigField(
                name="tavily_api_key",
                field_type=FieldType.PASSWORD,
                label="Tavily API Key",
                description="Only for the Tavily backend. From app.tavily.com.",
                placeholder="tvly-...",
                group="credentials",
                secure=True,
                apply_change=env_sync("TAVILY_API_KEY"),
            ),
            ConfigField(
                name="searxng_url",
                field_type=FieldType.URL,
                label="SearXNG URL",
                description="Only for the SearXNG backend. Your instance base URL.",
                placeholder="https://searxng.example.com",
                group="credentials",
                apply_change=env_sync("SEARXNG_URL"),
            ),
        ]
