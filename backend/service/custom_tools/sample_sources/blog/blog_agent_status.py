"""blog_agent_status — sample (python_inline).

Self-contained: this one BaseTool subclass + the helpers it uses.

위임 작업 진행 상황 조회 (사용자 paraphrase 용). BlogTaskRegistry 에서
in-memory state 를 읽어 반환한다. fire-and-poll 패턴의 polling 쪽.
"""
from __future__ import annotations

import json

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool


_LOOKUP = ToolCapabilities(
    concurrency_safe=True, read_only=True, idempotent=True,
    network_egress=True, max_result_chars=20_000,
)


def _err(msg: str, **extra) -> str:
    return json.dumps({"error": msg, **extra}, ensure_ascii=False)


class BlogAgentStatusTool(BaseTool):
    """위임 작업 진행 상황 조회 (사용자 paraphrase 용)."""

    name = "blog_agent_status"
    description = (
        "blog_agent_delegate 로 시작한 위임 작업의 현재 진행 상황을 조회. "
        "사용자가 '어디까지 됐어?', '얼마나 남았어?' 같은 질문을 할 때마다 "
        "호출. 응답은 progress_hint / elapsed_s / last_event_age_s 를 보고 "
        "사용자에게 자연어로 paraphrase 한다 — JSON / task_id 를 그대로 "
        "노출하지 마라. task_id 를 안 주면 현재 세션의 모든 진행 중 task "
        "를 요약."
    )
    CAPABILITIES = _LOOKUP

    def run(self, session_id: str, task_id: str = "") -> str:
        from service.blog_agent.registry import get_blog_task_registry
        registry = get_blog_task_registry()

        if task_id:
            state = registry.get(task_id)
            if state is None:
                return _err(f"unknown task_id: {task_id}")
            if state.geny_session_id != session_id:
                return _err(
                    f"task_id {task_id} 는 다른 세션의 task — 접근 거부",
                )
            return json.dumps(state.to_status_dict(), ensure_ascii=False)

        # task_id 미지정 → 현재 세션의 모든 task summary
        all_tasks = registry.list_for_session(session_id)
        if not all_tasks:
            return json.dumps(
                {"tasks": [], "message": "이 세션에 위임 기록이 없습니다."},
                ensure_ascii=False,
            )
        return json.dumps(
            {
                "tasks": [s.to_status_dict() for s in all_tasks],
                "active_count": sum(
                    1 for s in all_tasks if s.status in ("pending", "running")
                ),
            },
            ensure_ascii=False,
        )
