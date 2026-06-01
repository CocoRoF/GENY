"""blog_agent_cancel — sample (python_inline).

Self-contained: this one BaseTool subclass + the helpers it uses.

진행 중인 위임 task 를 취소. delegate 가 시작한 fire-and-poll pump
를 정지시키고 외부 blog Agent 에도 cancel 신호를 보낸다.
"""
from __future__ import annotations

import asyncio
import json

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool


_CANCEL = ToolCapabilities(
    concurrency_safe=False, read_only=False, idempotent=True,
    network_egress=True, max_result_chars=2_000,
)


def _err(msg: str, **extra) -> str:
    return json.dumps({"error": msg, **extra}, ensure_ascii=False)


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


class BlogAgentCancelTool(BaseTool):
    """위임 작업 취소."""

    name = "blog_agent_cancel"
    description = (
        "blog_agent_delegate 로 시작한 위임 작업을 취소. 사용자가 '취소', "
        "'그만해' 라고 명시한 경우에만 사용. 호출 후 사용자에게 한 줄로 "
        "'알겠어, 멈췄어' 라고 알린다."
    )
    CAPABILITIES = _CANCEL

    def run(self, session_id: str, task_id: str) -> str:
        from service.blog_agent.registry import get_blog_task_registry

        registry = get_blog_task_registry()
        state = registry.get(task_id)
        if state is None:
            return _err(f"unknown task_id: {task_id}")
        if state.geny_session_id != session_id:
            return _err(
                f"task_id {task_id} 는 다른 세션의 task — 접근 거부",
            )
        cancelled = _run_async(registry.cancel(task_id))
        try:
            from service.telemetry.blog_agent_metrics import record_cancel
            record_cancel(
                geny_session_id=session_id,
                task_id=task_id,
                reason="user",
            )
        except Exception:
            pass
        return json.dumps(
            {
                "task_id": task_id,
                "cancelled": cancelled,
                "status": state.status,
            },
            ensure_ascii=False,
        )
