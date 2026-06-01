"""blog_agent_list_posts — sample (python_inline).

Self-contained: only this one BaseTool subclass + the helpers it uses.

블로그의 포스트 목록을 조회 (참고용).
"""
from __future__ import annotations

import asyncio
import json

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool


_LOOKUP = ToolCapabilities(
    concurrency_safe=True, read_only=True, idempotent=True,
    network_egress=True, max_result_chars=20_000,
)


def _err(msg: str, **extra) -> str:
    return json.dumps({"error": msg, **extra}, ensure_ascii=False)


def _check_enabled() -> str | None:
    from service.config.manager import get_config_manager
    cfg = get_config_manager().get_config("blog_agent")
    if cfg is None:
        return _err("BlogAgentConfig is not registered")
    if not getattr(cfg, "enabled", False):
        return _err(
            "Blog Agent integration is disabled. "
            "Admin must enable it in Settings → Blog Agent.",
        )
    if not (getattr(cfg, "api_key", "") or "").strip():
        return _err("BLOG_AGENT_API_KEY is empty")
    if not (getattr(cfg, "base_url", "") or "").strip():
        return _err("BLOG_AGENT_BASE_URL is empty")
    return None


def _run_async(coro):
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    return asyncio.run(coro)


class BlogAgentListPostsTool(BaseTool):
    """블로그 포스트 목록 조회 (참고용)."""

    name = "blog_agent_list_posts"
    description = (
        "블로그의 포스트 목록을 조회. 사용자가 '글 목록 보여줘', '최근 글 "
        "뭐 있어' 같이 명시할 때만 사용. 위임 시작 전 컨텍스트 확인 용도로 "
        "쓸 수 있다."
    )
    CAPABILITIES = _LOOKUP

    def run(
        self,
        category: str = "",
        tag: str = "",
        search: str = "",
        published_only: bool = True,
        limit: int = 20,
    ) -> str:
        gate = _check_enabled()
        if gate is not None:
            return gate
        from service.blog_agent.client import AsyncBlogAgentClient

        async def _go():
            async with AsyncBlogAgentClient() as client:
                return await client.list_posts(
                    category=category or None,
                    tag=tag or None,
                    search=search or None,
                    published_only=published_only,
                )

        try:
            posts = _run_async(_go())
        except Exception as exc:  # noqa: BLE001
            return _err(f"list_posts failed: {exc}")
        if isinstance(posts, list):
            posts = posts[: max(1, min(limit, 100))]
        return json.dumps(
            {"posts": posts, "count": len(posts) if isinstance(posts, list) else 0},
            ensure_ascii=False,
            default=str,
        )
