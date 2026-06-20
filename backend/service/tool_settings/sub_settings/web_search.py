"""Web-search tool settings — pick the search backend + supply its API key.

geny-executor's web search supports DuckDuckGo (zero-config default), Brave,
Tavily and SearXNG. This schema lets each environment choose a backend and
provide the matching credential; the values land in
``ctx.extras["web_search"]`` which both the executor ``WebSearch`` tool and
Geny's ``web_search`` / ``news_search`` tools read.
"""

from __future__ import annotations

from typing import Any, Dict, List

from service.config.base import ConfigField, FieldType
from service.tool_settings.base import ToolSettingSchema, register_tool_setting


@register_tool_setting
class WebSearchToolSetting(ToolSettingSchema):
    @classmethod
    def get_key(cls) -> str:
        return "web_search"

    @classmethod
    def get_display_name(cls) -> str:
        return "Web Search"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Choose which search engine the web-search tools use in this "
            "environment. DuckDuckGo works with no key; Brave / Tavily / SearXNG "
            "give better results but need a key (or a server URL)."
        )

    @classmethod
    def get_icon(cls) -> str:
        return "search"

    @classmethod
    def get_fields(cls) -> List[ConfigField]:
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
            ),
            ConfigField(
                name="brave_api_key",
                field_type=FieldType.PASSWORD,
                label="Brave API Key",
                description="Only for the Brave backend. From api.search.brave.com.",
                placeholder="BSA...",
                group="credentials",
                secure=True,
            ),
            ConfigField(
                name="tavily_api_key",
                field_type=FieldType.PASSWORD,
                label="Tavily API Key",
                description="Only for the Tavily backend. From app.tavily.com.",
                placeholder="tvly-...",
                group="credentials",
                secure=True,
            ),
            ConfigField(
                name="searxng_url",
                field_type=FieldType.URL,
                label="SearXNG URL",
                description="Only for the SearXNG backend. Your instance base URL.",
                placeholder="https://searxng.example.com",
                group="credentials",
            ),
        ]

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "웹 검색",
                "description": (
                    "이 환경의 웹 검색 도구가 쓸 검색 엔진을 고릅니다. DuckDuckGo는 "
                    "키 없이 동작하고, Brave/Tavily/SearXNG는 결과가 더 좋지만 키(또는 "
                    "서버 URL)가 필요합니다."
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
                "# 웹 검색 백엔드 설정\n\n"
                "이 환경의 웹 검색이 어떤 엔진을 쓸지 정합니다. 값은 이 환경의 세션에만 "
                "적용돼요(다른 환경/전역엔 영향 없음).\n\n"
                "## 백엔드별\n"
                "- **DuckDuckGo** — 기본값, 키 불필요. 그대로 두면 됩니다.\n"
                "- **Brave** — `Brave API 키` 입력. <https://api.search.brave.com> 에서 "
                "발급(무료 등급 있음).\n"
                "- **Tavily** — `Tavily API 키` 입력. <https://app.tavily.com> 에서 발급. "
                "LLM 친화적 요약 결과.\n"
                "- **SearXNG** — 자체 호스팅 메타서치. `SearXNG URL`에 인스턴스 주소 "
                "입력(JSON 출력 허용 필요).\n\n"
                "> 키는 이 환경 매니페스트에 저장됩니다. 저장 후 새 세션부터 적용돼요.\n"
            ),
            "en": (
                "# Web search backend\n\n"
                "Pick the engine this environment's web search uses (applies only "
                "to this environment's sessions).\n\n"
                "- **DuckDuckGo** — default, no key. Leave as-is.\n"
                "- **Brave** — paste a key from <https://api.search.brave.com> (free tier).\n"
                "- **Tavily** — paste a key from <https://app.tavily.com> (LLM-friendly).\n"
                "- **SearXNG** — self-hosted; put your instance URL (JSON output enabled).\n\n"
                "> Keys are stored on this environment's manifest; new sessions pick them up.\n"
            ),
        }
