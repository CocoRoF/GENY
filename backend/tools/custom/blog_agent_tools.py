"""Blog Agent Delegation Tools — VTuber 가 외부 블로그 AI Agent 에 작업을 위임.

설계: BLOG_AGENT_DELEGATION_PLAN.md (v2)

5개 tool:

  blog_agent_delegate     작업 위임 시작 (비동기, 즉시 task_id 반환)
  blog_agent_status       위임 진행 상황 조회 (사용자 paraphrase 용)
  blog_agent_cancel       진행 중 task 취소
  blog_agent_list_posts   참고용 포스트 목록 조회
  blog_agent_get_post     참고용 포스트 상세 조회

핵심 시맨틱 — fire-and-poll:
  delegate 는 절대 turn 끝까지 기다리지 않는다. 즉시 task_id 만 반환하고,
  pump_task 가 백그라운드에서 SSE 를 끝까지 소비. 완료 시 [EXTERNAL_TASK_RESULT]
  봉투가 호출자 inbox 에 자동 도착해 paraphrase turn 이 트리거된다.

권한/노출:
  default 로 VTuber Env 만 노출 (env 템플릿 whitelist + Worker deny).
  Sub-Worker 는 BlogAgentConfig.enabled_for_subworkers=True + env 재발급
  두 단계가 모두 필요 — 우발적 활성화 방지.

이 파일은 ToolLoader 에 의해 자동 로드된다 (*_tools.py 패턴).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool

logger = logging.getLogger(__name__)


# ─── Capability presets ──────────────────────────────────────────

_LOOKUP = ToolCapabilities(
    concurrency_safe=True, read_only=True, idempotent=True,
    network_egress=True, max_result_chars=20_000,
)
_DELEGATE = ToolCapabilities(
    concurrency_safe=False, read_only=False, idempotent=False,
    network_egress=True, max_result_chars=4_000,
)
_CANCEL = ToolCapabilities(
    concurrency_safe=False, read_only=False, idempotent=True,
    network_egress=True, max_result_chars=2_000,
)


# ─── helpers ─────────────────────────────────────────────────────


def _config():
    """BlogAgentConfig lazy 로드."""
    from service.config.manager import get_config_manager
    return get_config_manager().get_config("blog_agent")


def _err(msg: str, **extra) -> str:
    payload = {"error": msg, **extra}
    return json.dumps(payload, ensure_ascii=False)


def _check_enabled() -> Optional[str]:
    cfg = _config()
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
    """sync run() 안에서 async coroutine 실행 — 이벤트 루프 유무에 무관."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    return asyncio.run(coro)


async def _ensure_blog_session_uid(
    *,
    geny_session_id: str,
    title_hint: str,
    reuse: bool,
) -> str:
    """이 Geny 세션과 매핑된 blog_session_uid 를 보장.

    매핑은 AgentSession 인스턴스에 ``_blog_session_uid`` 속성으로 보관
    (in-memory). 재시작 시 손실되지만 블로그 세션 자체는 살아있으므로
    필요하면 LLM 이 list_sessions 로 다시 확인 가능 — 본 v1 의 trade-off.
    """
    from service.executor import get_agent_session_manager
    from service.blog_agent.client import AsyncBlogAgentClient

    agent = get_agent_session_manager().get_agent(geny_session_id)
    if reuse and agent is not None:
        existing = getattr(agent, "_blog_session_uid", None)
        if existing:
            return existing

    async with AsyncBlogAgentClient() as client:
        row = await client.create_session(title=title_hint or "Geny delegation")
    blog_uid = row["session_uid"]
    if agent is not None:
        try:
            agent._blog_session_uid = blog_uid
        except Exception:
            logger.debug(
                "could not stash _blog_session_uid on agent %s",
                geny_session_id, exc_info=True,
            )
    return blog_uid


def _record_request_in_stm(
    *,
    geny_session_id: str,
    blog_session_uid: str,
    task_id: str,
    task_summary: str,
    user_text: str,
) -> None:
    """위임 호출 시 호출자 STM 에 EXTERNAL_TASK_REQUEST 이벤트 기록.

    DM 이 아니라 도구 호출 결과이므로 자동 분류 경로 (_classify_outgoing_dm)
    가 아니라 이쪽에서 손으로 metadata 를 만들어 ``record_message`` 한다.
    실패해도 도구 흐름은 계속 (best-effort).
    """
    try:
        from service.executor import get_agent_session_manager
        from service.memory.interaction_event import (
            CounterpartRole,
            Direction,
            Kind,
            make_event_metadata,
        )

        agent = get_agent_session_manager().get_agent(geny_session_id)
        if agent is None:
            return
        memory = getattr(agent, "_memory_manager", None)
        if memory is None:
            return

        body = (
            f"[EXTERNAL_TASK_REQUEST]\n"
            f"To: blog:{blog_session_uid}\n"
            f"Task: {task_id}\n"
            f"Summary: {task_summary}\n\n"
            f"{user_text[:1500]}"
        )
        metadata = make_event_metadata(
            kind=Kind.EXTERNAL_TASK_REQUEST,
            direction=Direction.OUT,
            counterpart_id=f"blog:{blog_session_uid}",
            counterpart_role=CounterpartRole.EXTERNAL_AGENT,
        )
        memory.record_message("assistant_tool", body[:8000], metadata=metadata)
    except Exception:
        logger.debug(
            "external_task_request STM record failed (non-critical)",
            exc_info=True,
        )


# ─── 1. delegate ─────────────────────────────────────────────────


class BlogAgentDelegateTool(BaseTool):
    """블로그 AI Agent 에게 글쓰기 / 편집 작업을 위임 (비동기 시작)."""

    name = "blog_agent_delegate"
    description = (
        "외부 블로그 AI Agent 에게 글쓰기 / 편집 / 관리 작업을 위임한다. "
        "이 도구는 작업을 비동기로 시작만 하고 즉시 task_id 를 반환한다 — "
        "절대 turn 끝까지 기다리지 않는다. 사용자에게는 '맡겼어, 잠깐만' "
        "정도로 알리고 너의 turn 을 종료해라. 진행 상황을 사용자가 물으면 "
        "blog_agent_status(task_id) 로 확인한다. 작업 완료 시 결과는 "
        "자동으로 inbox 에 도착해 paraphrase 된다 — 이 도구의 반환값을 "
        "사용자에게 그대로 노출하지 마라. 같은 turn 에서 두 번 호출 금지."
    )
    CAPABILITIES = _DELEGATE

    def run(
        self,
        session_id: str,
        task: str,
        task_summary: str = "",
        reuse_session: bool = True,
    ) -> str:
        return _run_async(self.arun(
            session_id=session_id,
            task=task,
            task_summary=task_summary,
            reuse_session=reuse_session,
        ))

    async def arun(
        self,
        session_id: str,
        task: str,
        task_summary: str = "",
        reuse_session: bool = True,
    ) -> str:
        """위임 시작.

        Args:
            session_id: 호출자 (VTuber) 세션 ID — adapter 가 자동 주입.
            task: 블로그 AI 에게 전달할 한국어 지시문 (카테고리/태그/스타일 포함).
            task_summary: 사용자에게 들려줄 한 줄 요약 (5단어 이내 권장).
            reuse_session: True 면 이 Geny 세션의 기존 blog_session 재사용.
        """
        gate = _check_enabled()
        if gate is not None:
            return gate
        if not (task or "").strip():
            return _err("task must be non-empty")

        cfg = _config()

        # 동시 위임 상한 검사
        from service.blog_agent.registry import get_blog_task_registry
        registry = get_blog_task_registry()
        active = registry.active_count_for_session(session_id)
        if active >= int(getattr(cfg, "max_concurrent_per_session", 2) or 2):
            return _err(
                f"이 세션에 이미 {active} 개의 위임 task 가 진행 중입니다. "
                "끝나거나 취소된 후 다시 시도해주세요.",
                active_count=active,
            )

        try:
            blog_uid = await _ensure_blog_session_uid(
                geny_session_id=session_id,
                title_hint=task_summary or task[:60],
                reuse=reuse_session,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("blog_agent_delegate session setup failed")
            return _err(f"failed to obtain blog session: {exc}")

        # 결과가 도착하면 호출자 inbox 에 deliver + paraphrase trigger
        from service.blog_agent.delivery import deliver_external_result

        async def _on_finished(state, kind: str) -> None:
            await deliver_external_result(state, kind)

        state = await registry.start(
            geny_session_id=session_id,
            blog_session_uid=blog_uid,
            user_text=task,
            task_summary=(task_summary or task[:60]).strip(),
            on_finished=_on_finished,
        )

        # STM 에 EXTERNAL_TASK_REQUEST 기록 (best-effort)
        _record_request_in_stm(
            geny_session_id=session_id,
            blog_session_uid=blog_uid,
            task_id=state.task_id,
            task_summary=state.task_summary,
            user_text=task,
        )

        # telemetry hook (Phase 5)
        try:
            from service.telemetry.blog_agent_metrics import record_delegate_start
            record_delegate_start(
                geny_session_id=session_id,
                blog_session_uid=blog_uid,
                task_id=state.task_id,
                summary_chars=len(state.task_summary),
            )
        except Exception:
            pass

        return json.dumps({
            "task_id": state.task_id,
            "blog_session_uid": blog_uid,
            "task_summary": state.task_summary,
            "status": state.status,
            "message": (
                "작업을 시작했습니다. 사용자에게 '맡겼어, 잠깐만' 정도로 "
                "알리고 너의 turn 을 종료하세요. 결과는 자동으로 도착합니다."
            ),
        }, ensure_ascii=False)


# ─── 2. status ───────────────────────────────────────────────────


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
        return json.dumps({
            "tasks": [s.to_status_dict() for s in all_tasks],
            "active_count": sum(
                1 for s in all_tasks if s.status in ("pending", "running")
            ),
        }, ensure_ascii=False)


# ─── 3. cancel ───────────────────────────────────────────────────


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
        return json.dumps({
            "task_id": task_id,
            "cancelled": cancelled,
            "status": state.status,
        }, ensure_ascii=False)


# ─── 4. list_posts ───────────────────────────────────────────────


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
            posts = posts[:max(1, min(limit, 100))]
        return json.dumps(
            {"posts": posts, "count": len(posts) if isinstance(posts, list) else 0},
            ensure_ascii=False,
            default=str,
        )


# ─── 5. get_post ─────────────────────────────────────────────────


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


# ─── Export ──────────────────────────────────────────────────────

TOOLS = [
    BlogAgentDelegateTool(),
    BlogAgentStatusTool(),
    BlogAgentCancelTool(),
    BlogAgentListPostsTool(),
    BlogAgentGetPostTool(),
]
