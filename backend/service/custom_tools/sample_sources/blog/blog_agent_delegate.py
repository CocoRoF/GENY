"""blog_agent_delegate — sample (python_inline).

Self-contained: this one BaseTool subclass + the helpers it uses.

핵심 시맨틱 — fire-and-poll:
  delegate 는 절대 turn 끝까지 기다리지 않는다. 즉시 task_id 만 반환하고,
  pump_task 가 백그라운드에서 SSE 를 끝까지 소비. 완료 시
  [EXTERNAL_TASK_RESULT] 봉투가 호출자 inbox 에 자동 도착해 paraphrase
  turn 이 트리거된다.

권한/노출 메모: 이 도구는 VTuber 환경의 whitelist 에 의해 노출되며
Sub-Worker 환경에서는 deny 처리되는 것이 안전합니다 (의도치 않은 글
발행 방지). 환경 매니페스트의 ``tools.external`` 또는 deny 리스트로
조정하세요.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional

from geny_executor.tools.base import ToolCapabilities
from tools.base import BaseTool


logger = logging.getLogger(__name__)


_DELEGATE = ToolCapabilities(
    concurrency_safe=False, read_only=False, idempotent=False,
    network_egress=True, max_result_chars=4_000,
)


def _err(msg: str, **extra) -> str:
    return json.dumps({"error": msg, **extra}, ensure_ascii=False)


def _config():
    from service.config.manager import get_config_manager
    return get_config_manager().get_config("blog_agent")


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
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    return asyncio.run(coro)


_VALID_PROMPT_MODES = ("persona", "research", "explorer")


def _normalize_prompt_mode(mode: str) -> str:
    """blog 측 normalize_prompt_mode 와 동일 룰 — 알 수 없는 값은 persona."""
    if not mode:
        return "persona"
    m = mode.strip().lower()
    return m if m in _VALID_PROMPT_MODES else "persona"


async def _ensure_blog_session_uid(
    *,
    geny_session_id: str,
    title_hint: str,
    reuse: bool,
    prompt_mode: str,
    model: str,
) -> str:
    """이 Geny 세션과 매핑된 blog_session_uid 를 보장.

    매핑은 AgentSession 인스턴스에 ``_blog_session_uid`` 속성으로 보관.
    재시작 시 손실되지만 블로그 세션 자체는 살아있으므로 필요하면 LLM
    이 list_sessions 로 다시 확인 가능 — 본 v1 의 trade-off.

    재사용 경로: 기존 세션이 있더라도 호출자가 prompt_mode / model 을
    명시했고 현재 세션의 값과 다르면 PATCH 로 동기화. 진행 중 turn 이
    있으면 blog 측이 409 를 반환 — 그 경우 위쪽 try/except 가
    BlogAgentHTTPError 로 받아 호출자에 전달.
    """
    from service.executor import get_agent_session_manager
    from service.blog_agent.client import AsyncBlogAgentClient

    agent = get_agent_session_manager().get_agent(geny_session_id)
    if reuse and agent is not None:
        existing = getattr(agent, "_blog_session_uid", None)
        if existing:
            try:
                async with AsyncBlogAgentClient() as client:
                    cur = await client.get_session(existing, include_messages=False)
                    cur_session = (cur or {}).get("session") or cur or {}
                    patch_kwargs: Dict[str, Any] = {}
                    if prompt_mode and cur_session.get("prompt_mode") != prompt_mode:
                        patch_kwargs["prompt_mode"] = prompt_mode
                    if model and cur_session.get("model") != model:
                        patch_kwargs["model"] = model
                    if patch_kwargs:
                        await client.update_session(existing, **patch_kwargs)
            except Exception:
                # PATCH 실패는 위임 자체를 막지 않음.
                logger.debug(
                    "blog session sync (PATCH) failed — proceeding",
                    exc_info=True,
                )
            return existing

    async with AsyncBlogAgentClient() as client:
        row = await client.create_session(
            title=title_hint or "Geny delegation",
            model=model or None,
            prompt_mode=prompt_mode or None,
        )
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


async def _record_request_in_stm(
    *,
    geny_session_id: str,
    blog_session_uid: str,
    task_id: str,
    task_summary: str,
    user_text: str,
) -> None:
    """위임 호출 시 호출자 STM 에 EXTERNAL_TASK_REQUEST 이벤트 기록.

    DM 이 아니라 도구 호출 결과이므로 자동 분류 경로가 아니라 이쪽에서
    손으로 metadata 를 만들어 기록한다. 실패해도 도구 흐름은 계속
    (best-effort).

    Records ASYNC-NATIVELY (``await ...stm().append``) instead of the sync
    ``record_message`` wrapper. ``record_message`` bridges through
    ``run_coro_sync`` — on the event loop that blocks the loop on a worker
    future whose ``notes.write`` (fired by the ``after_record_turn`` archive
    hook) can deadlock on a memory ``LoopAgnosticLock``. Awaiting the append
    directly keeps the loop free; the hook then offloads archiving normally.
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
        # Equivalent to ``record_message`` (no ``extra`` kwargs → out_meta ==
        # metadata) but async-native, so it fires the archive hook on the
        # live loop rather than through the loop-blocking sync bridge.
        await memory._stm_append_message("assistant_tool", body[:8000], metadata)
    except Exception:
        logger.debug(
            "external_task_request STM record failed (non-critical)",
            exc_info=True,
        )


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
        "사용자에게 그대로 노출하지 마라. 같은 turn 에서 두 번 호출 금지. "
        "prompt_mode 로 voice 를, model 로 블로그 측 사용 모델 (claude-* / "
        "gpt-*) 을 호출별로 override 할 수 있다. prompt_mode 옵션: "
        "persona = 25세 카주얼 블로거 (글쓰기 default), research = 진지·정보 "
        "톤 (글쓰기), explorer = 글쓰기 voice 가 아닌 탐색 도우미 (이미 있는 "
        "글·태그·카테고리 빠르게 찾고 정리). 미지정이면 BlogAgentConfig 의 "
        "default 값이 적용. 재사용 세션이고 값이 다르면 호출 직전 PATCH 로 "
        "동기화한다."
    )
    CAPABILITIES = _DELEGATE

    def run(
        self,
        session_id: str,
        task: str,
        task_summary: str = "",
        reuse_session: bool = True,
        prompt_mode: str = "",
        model: str = "",
    ) -> str:
        return _run_async(self.arun(
            session_id=session_id,
            task=task,
            task_summary=task_summary,
            reuse_session=reuse_session,
            prompt_mode=prompt_mode,
            model=model,
        ))

    async def arun(
        self,
        session_id: str,
        task: str,
        task_summary: str = "",
        reuse_session: bool = True,
        prompt_mode: str = "",
        model: str = "",
    ) -> str:
        """위임 시작.

        Args:
            session_id: 호출자 (VTuber) 세션 ID — adapter 가 자동 주입.
            task: 블로그 AI 에게 전달할 한국어 지시문 (카테고리/태그/스타일 포함).
            task_summary: 사용자에게 들려줄 한 줄 요약 (5단어 이내 권장).
            reuse_session: True 면 이 Geny 세션의 기존 blog_session 재사용.
            prompt_mode: "persona" | "research" | "explorer" — voice 명시.
            model: blog 측 모델 ID 명시. 빈 문자열이면 cfg default 적용.
        """
        gate = _check_enabled()
        if gate is not None:
            return gate
        if not (task or "").strip():
            return _err("task must be non-empty")

        cfg = _config()

        resolved_prompt_mode = _normalize_prompt_mode(
            prompt_mode or getattr(cfg, "default_prompt_mode", "persona") or "persona",
        )
        resolved_model = (
            (model or "").strip()
            or (getattr(cfg, "default_model", "") or "").strip()
            or "claude-sonnet-4-6"
        )

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
                prompt_mode=resolved_prompt_mode,
                model=resolved_model,
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

        # STM 에 EXTERNAL_TASK_REQUEST 기록 (best-effort). Async-native —
        # see the note on ``_record_request_in_stm``.
        await _record_request_in_stm(
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

        return json.dumps(
            {
                "task_id": state.task_id,
                "blog_session_uid": blog_uid,
                "task_summary": state.task_summary,
                "status": state.status,
                "prompt_mode": resolved_prompt_mode,
                "model": resolved_model,
                "message": (
                    "작업을 시작했습니다. 사용자에게 '맡겼어, 잠깐만' 정도로 "
                    "알리고 너의 turn 을 종료하세요. 결과는 자동으로 도착합니다."
                ),
            },
            ensure_ascii=False,
        )
