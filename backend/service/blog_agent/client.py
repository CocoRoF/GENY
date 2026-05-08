"""AsyncBlogAgentClient — 블로그 외부 API 의 typed httpx 래퍼.

블로그 측 라우터: ``hr_blog2.0/backend/src/controllers/agent_external.py``
- POST /api/v1/agent/external/sessions               생성
- GET  /api/v1/agent/external/sessions               목록
- GET  /api/v1/agent/external/sessions/{uid}         상세
- PATCH/DELETE /sessions/{uid}                       메타/삭제
- POST /sessions/{uid}/messages         (sync)       동기 채팅
- POST /sessions/{uid}/messages/stream  (SSE)        스트리밍 채팅
- POST /sessions/{uid}/cancel           (Phase 0)    진행 turn 취소

설계 결정:
  - 모든 호출에 X-Request-ID 자동 생성 / 전송 (감사 추적).
  - SSE 외에는 read timeout 60s, connect 10s. SSE 는 read timeout 무한.
  - 4xx/5xx → BlogAgentHTTPError, transport 실패 → BlogAgentTransportError.
  - 재시도 안 함 — 블로그 turn 은 idempotent 하지 않음 (같은 글 두 번 생성 위험).
  - api_key 가 예외 메시지에 포함되지 않도록 url 만 노출.
  - config.enabled=False 거나 키 미설정 → BlogAgentNotConfigured.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from service.blog_agent.events import Frame, iter_blocks_from_lines, parse_sse_block
from service.blog_agent.exceptions import (
    BlogAgentHTTPError,
    BlogAgentNotConfigured,
    BlogAgentTransportError,
)

logger = logging.getLogger(__name__)


_DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=5.0)


def _config():
    """BlogAgentConfig 를 lazy 로 가져옴 — 부팅 시점 import 순환 회피."""
    from service.config.manager import get_config_manager

    mgr = get_config_manager()
    return mgr.get_config("blog_agent")


def _require_config() -> "Any":
    cfg = _config()
    if cfg is None:
        raise BlogAgentNotConfigured("BlogAgentConfig is not registered")
    if not getattr(cfg, "enabled", False):
        raise BlogAgentNotConfigured(
            "Blog Agent integration is disabled. "
            "Enable it in Settings → Blog Agent.",
        )
    if not (getattr(cfg, "api_key", "") or "").strip():
        raise BlogAgentNotConfigured(
            "BLOG_AGENT_API_KEY is empty. Set it in Settings or .env.",
        )
    if not (getattr(cfg, "base_url", "") or "").strip():
        raise BlogAgentNotConfigured(
            "BLOG_AGENT_BASE_URL is empty. Set it in Settings or .env.",
        )
    return cfg


def _new_request_id() -> str:
    return uuid.uuid4().hex


def _record_transport_failure(url: str, status_code, detail: str) -> None:
    """Telemetry hook — best-effort. base_url 만 노출 (api_key 는 헤더 only)."""
    try:
        from urllib.parse import urlsplit
        parts = urlsplit(url)
        base = f"{parts.scheme}://{parts.netloc}" if parts.netloc else url

        from service.telemetry.blog_agent_metrics import record_transport_error
        record_transport_error(
            geny_session_id=None,   # client 레이어는 caller 컨텍스트 모름
            base_url=base,
            status_code=status_code,
            detail=detail,
        )
    except Exception:
        # telemetry 실패는 전파 안 함
        pass


class AsyncBlogAgentClient:
    """블로그 외부 API 비동기 클라이언트.

    Lifecycle: 일반적으로 ``async with`` 로 사용. registry pump 는
    한 위임 task 의 lifetime 동안 단일 인스턴스를 유지.

    Args:
        cfg: 검증된 BlogAgentConfig 인스턴스. None 이면 매 호출 시 lazy 로드.
    """

    def __init__(self, cfg: "Any" = None):
        self._cfg = cfg
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self) -> "AsyncBlogAgentClient":
        self._client = httpx.AsyncClient(
            timeout=_DEFAULT_TIMEOUT,
            follow_redirects=False,
            verify=True,
        )
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ─── 내부 헬퍼 ─────────────────────────────────────────────

    def _resolve_cfg(self):
        return self._cfg or _require_config()

    def _headers(self, cfg, *, request_id: str) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {cfg.api_key}",
            "X-Request-ID": request_id,
            "Accept": "application/json",
            "User-Agent": "Geny-BlogAgent-Client/1.0",
        }

    def _url(self, cfg, path: str) -> str:
        return f"{cfg.base_url.rstrip('/')}{path}"

    @staticmethod
    def _safe_url_for_error(url: str) -> str:
        # api_key 는 헤더로만 가므로 url 만 노출해도 안전
        return url

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        cfg = self._resolve_cfg()
        request_id = _new_request_id()
        url = self._url(cfg, path)
        headers = self._headers(cfg, request_id=request_id)
        if self._client is None:
            # 일회성 호출 — 새 client 생성/정리.
            async with httpx.AsyncClient(
                timeout=_DEFAULT_TIMEOUT,
                follow_redirects=False,
                verify=True,
            ) as client:
                return await self._do_request(
                    client, method, url, headers, body, params, request_id,
                )
        return await self._do_request(
            self._client, method, url, headers, body, params, request_id,
        )

    @staticmethod
    async def _do_request(
        client: httpx.AsyncClient,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[Dict[str, Any]],
        params: Optional[Dict[str, Any]],
        request_id: str,
    ) -> Any:
        try:
            response = await client.request(
                method, url, headers=headers, json=body, params=params,
            )
        except httpx.TimeoutException as exc:
            logger.warning("blog_agent transport timeout url=%s req=%s", url, request_id)
            _record_transport_failure(url, None, f"timeout: {exc}")
            raise BlogAgentTransportError(f"timeout calling blog API: {exc}") from exc
        except httpx.TransportError as exc:
            logger.warning(
                "blog_agent transport error url=%s req=%s err=%s",
                url, request_id, exc,
            )
            _record_transport_failure(url, None, f"transport: {exc}")
            raise BlogAgentTransportError(f"transport error: {exc}") from exc

        if response.status_code >= 400:
            detail = AsyncBlogAgentClient._extract_detail(response)
            _record_transport_failure(url, response.status_code, detail)
            raise BlogAgentHTTPError(response.status_code, detail, url=url)

        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except json.JSONDecodeError:
            return {"raw": response.text}

    @staticmethod
    def _extract_detail(response: httpx.Response) -> str:
        try:
            payload = response.json()
            if isinstance(payload, dict):
                return str(payload.get("detail") or payload.get("error") or payload)
            return str(payload)
        except json.JSONDecodeError:
            text = (response.text or "").strip()
            return text[:300] if text else response.reason_phrase

    # ─── Public API: 세션 CRUD ─────────────────────────────────

    async def create_session(
        self,
        *,
        title: str = "",
        model: Optional[str] = None,
        prompt_mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        cfg = self._resolve_cfg()
        body: Dict[str, Any] = {
            "title": title,
            "model": model or cfg.default_model,
            "prompt_mode": (
                prompt_mode
                or getattr(cfg, "default_prompt_mode", None)
                or "persona"
            ),
        }
        return await self._request_json(
            "POST", "/api/v1/agent/external/sessions", body=body,
        )

    async def update_session(
        self,
        session_uid: str,
        *,
        title: Optional[str] = None,
        model: Optional[str] = None,
        prompt_mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        """기존 세션의 메타 (title) / 모델 / voice mode 변경.

        blog 측은 진행 중 turn 이 있으면 model / prompt_mode 변경에 409 를 반환.
        호출자는 이 경우 cancel 후 재시도하거나 다음 turn 까지 기다려야 함.
        """
        body: Dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if model is not None:
            body["model"] = model
        if prompt_mode is not None:
            body["prompt_mode"] = prompt_mode
        if not body:
            return await self.get_session(session_uid)
        return await self._request_json(
            "PATCH",
            f"/api/v1/agent/external/sessions/{session_uid}",
            body=body,
        )

    async def list_sessions(self, limit: int = 200) -> List[Dict[str, Any]]:
        return await self._request_json(
            "GET", "/api/v1/agent/external/sessions", params={"limit": limit},
        )

    async def get_session(
        self,
        session_uid: str,
        *,
        include_messages: bool = False,
        messages_limit: int = 200,
    ) -> Dict[str, Any]:
        return await self._request_json(
            "GET",
            f"/api/v1/agent/external/sessions/{session_uid}",
            params={
                "include_messages": str(include_messages).lower(),
                "messages_limit": messages_limit,
            },
        )

    async def delete_session(self, session_uid: str) -> None:
        await self._request_json(
            "DELETE", f"/api/v1/agent/external/sessions/{session_uid}",
        )

    async def cancel(self, session_uid: str) -> Dict[str, Any]:
        """진행 중 turn 취소. SessionState 보존."""
        return await self._request_json(
            "POST", f"/api/v1/agent/external/sessions/{session_uid}/cancel",
        )

    # ─── Public API: 채팅 ──────────────────────────────────────

    async def send_message_sync(
        self,
        session_uid: str,
        text: str,
        *,
        timeout_seconds: Optional[float] = None,
        client_request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        cfg = self._resolve_cfg()
        body = {
            "text": text,
            "timeout_seconds": timeout_seconds or cfg.default_timeout_s,
        }
        if client_request_id:
            body["client_request_id"] = client_request_id
        return await self._request_json(
            "POST",
            f"/api/v1/agent/external/sessions/{session_uid}/messages",
            body=body,
        )

    async def stream_message(
        self,
        session_uid: str,
        text: str,
        *,
        client_request_id: Optional[str] = None,
    ) -> AsyncIterator[Frame]:
        """SSE 로 frame 을 한 줄씩 yield. ``turn_complete`` / ``error``
        도착 후에도 stream 이 닫힐 때까지 (즉 sentinel 까지) 마저 소비.

        호출자가 generator close 하면 underlying connection 도 close.
        """
        cfg = self._resolve_cfg()
        request_id = client_request_id or _new_request_id()
        url = self._url(cfg, f"/api/v1/agent/external/sessions/{session_uid}/messages/stream")
        headers = {
            **self._headers(cfg, request_id=request_id),
            "Accept": "text/event-stream",
        }
        body = {"text": text, "client_request_id": request_id}

        async with httpx.AsyncClient(
            timeout=_STREAM_TIMEOUT, follow_redirects=False, verify=True,
        ) as client:
            try:
                async with client.stream(
                    "POST", url, headers=headers, json=body,
                ) as response:
                    if response.status_code >= 400:
                        # error body 읽기
                        await response.aread()
                        detail = AsyncBlogAgentClient._extract_detail(response)
                        raise BlogAgentHTTPError(response.status_code, detail, url=url)

                    buffer: list[str] = []
                    async for raw_line in response.aiter_lines():
                        # aiter_lines 가 빈 라인을 포함해서 줌 → 이게 block separator.
                        if raw_line == "" or raw_line == "\n" or raw_line == "\r\n":
                            blocks = iter_blocks_from_lines(buffer + [""])
                            buffer = []
                            for blk in blocks:
                                frame = parse_sse_block(blk)
                                if frame is not None:
                                    yield frame
                        else:
                            buffer.append(raw_line)

                    # stream 종료 — 마지막 미완료 블록 처리
                    if buffer:
                        blocks = iter_blocks_from_lines(buffer, complete_block=True)
                        for blk in blocks:
                            frame = parse_sse_block(blk)
                            if frame is not None:
                                yield frame
            except httpx.TimeoutException as exc:
                raise BlogAgentTransportError(f"SSE timeout: {exc}") from exc
            except httpx.TransportError as exc:
                raise BlogAgentTransportError(f"SSE transport error: {exc}") from exc

    # ─── 블로그 일반 콘텐츠 API (참고용) ─────────────────────────
    # external API 는 blog post 자체는 다루지 않음 → 공개 GET 엔드포인트
    # /api/v1/posts 로 직접 호출. 이 엔드포인트들은 인증이 필요 없으나
    # 동일 base_url 을 재사용한다.

    async def list_posts(
        self,
        *,
        category: Optional[str] = None,
        tag: Optional[str] = None,
        search: Optional[str] = None,
        published_only: bool = True,
    ) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {"published_only": str(published_only).lower()}
        if category:
            params["category"] = category
        if tag:
            params["tag"] = tag
        if search:
            params["search"] = search
        return await self._request_json("GET", "/api/v1/posts", params=params)

    async def get_post(self, slug: str) -> Dict[str, Any]:
        return await self._request_json("GET", f"/api/v1/posts/{slug}")
