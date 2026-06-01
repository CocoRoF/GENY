"""blog_agent_get_post — sample (python_inline).

Self-contained: only this one BaseTool subclass + the helpers it uses.
Read it as a starting point for your own custom tools.

블로그의 특정 포스트 상세 (markdown content 포함) 를 조회.
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
    """Gate the tool on BlogAgentConfig — admin must enable in Settings."""
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
    """Run an async coroutine from inside a sync run() — works whether or
    not the caller is already inside an event loop."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    return asyncio.run(coro)


class BlogAgentGetPostTool(BaseTool):
    """블로그 포스트 상세 조회 (참고용)."""

    name = "blog_agent_get_post"
    description = (
        "블로그의 특정 포스트 상세 (markdown content 포함) 를 조회. 사용자가 "
        "특정 글 내용을 인용하거나 수정 작업의 base 로 삼고 싶을 때 사용."
    )
    CAPABILITIES = _LOOKUP

    def run(self, slug: str) -> str:
        gate = _check_enabled()
        if gate is not None:
            return gate
        if not (slug or "").strip():
            return _err("slug must be non-empty")
        from service.blog_agent.client import AsyncBlogAgentClient

        async def _go():
            async with AsyncBlogAgentClient() as client:
                return await client.get_post(slug)

        try:
            post = _run_async(_go())
        except Exception as exc:  # noqa: BLE001
            return _err(f"get_post failed: {exc}")
        return json.dumps(post, ensure_ascii=False, default=str)
