"""Blog Agent 통합 예외 계층.

키 누설을 막기 위해 모든 메시지에서 ``api_key`` 가 절대 포함되지 않도록
호출 측이 sanitize 한 텍스트만 raise 한다 (str() 가 그대로 로그/에러 응답에
들어갈 수 있음을 가정).
"""
from __future__ import annotations

from typing import Optional


class BlogAgentError(Exception):
    """Blog Agent 통합 공통 베이스."""


class BlogAgentNotConfigured(BlogAgentError):
    """``BlogAgentConfig.enabled`` 가 False 이거나 키/URL 미설정."""


class BlogAgentHTTPError(BlogAgentError):
    """블로그 API 가 4xx/5xx 응답."""

    def __init__(self, status_code: int, detail: str, *, url: Optional[str] = None):
        self.status_code = status_code
        self.detail = detail
        self.url = url
        suffix = f" url={url}" if url else ""
        super().__init__(f"blog API HTTP {status_code}: {detail}{suffix}")


class BlogAgentTransportError(BlogAgentError):
    """connect/read/네트워크 실패. retry 여부는 호출자가 결정."""


class BlogAgentCancelled(BlogAgentError):
    """위임이 cancel 토큰에 의해 중단됨 — 정상 종료 표시 (에러 아님)."""
