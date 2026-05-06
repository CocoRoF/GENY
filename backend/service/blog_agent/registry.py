"""BlogTaskRegistry — 위임 task 의 in-memory 진행 상태.

VTuber 가 ``blog_agent_delegate`` 를 호출하면 즉시 task_id 가 반환되고
백그라운드 ``pump_task`` 가 SSE frame 을 끝까지 소비. 사용자가
"어디까지 됐어?" 라고 물어보면 ``blog_agent_status(task_id)`` 가 이
registry 의 누적 상태를 읽어 LLM-paraphrase 친화적 dict 로 반환.

핵심 invariants:

  * 한 ``BlogTaskState`` 는 단일 ``geny_session_id`` 와 ``blog_session_uid``
    에 영구 binding (생성 시점부터). reuse 정책은 호출자가 결정.
  * pump_task 는 lifetime 동안 단 하나. cancel 시 ``cancel_token`` 을
    set 하면 pump 가 다음 frame 경계에서 client.cancel(blog_session_uid)
    를 호출하고 status="cancelled" 로 마감.
  * frame deque 는 최대 200개 (FIFO drop) — context 폭증 방지.
  * 완료/취소/에러 task 는 24h 후 GC. 진행중 task 는 timeout 으로만 종료.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Literal, Optional

from service.blog_agent.client import AsyncBlogAgentClient
from service.blog_agent.events import Frame
from service.blog_agent.exceptions import (
    BlogAgentCancelled,
    BlogAgentError,
    BlogAgentHTTPError,
    BlogAgentTransportError,
)

logger = logging.getLogger(__name__)


TaskStatus = Literal["pending", "running", "done", "cancelled", "error"]


_FRAME_DEQUE_MAX = 200
_LAST_TEXT_MAX = 8 * 1024
_GC_AGE = timedelta(hours=24)


@dataclass
class FrameSummary:
    """frame 한 건의 1줄 요약 — registry 가 메모리에 보관."""

    ts: datetime
    type: str
    summary: str  # human-readable 요약, 200자 이하


@dataclass
class BlogTaskState:
    task_id: str
    geny_session_id: str
    blog_session_uid: str
    task_summary: str
    user_text: str
    status: TaskStatus
    started_at: datetime
    last_event_at: datetime
    frames: deque = field(default_factory=lambda: deque(maxlen=_FRAME_DEQUE_MAX))
    last_assistant_chunk: str = ""
    final_text: str = ""
    error: Optional[str] = None
    tool_call_counts: Dict[str, int] = field(default_factory=dict)
    pump_task: Optional[asyncio.Task] = None
    cancel_token: asyncio.Event = field(default_factory=asyncio.Event)
    finished_at: Optional[datetime] = None

    # 결과 deliver 단계가 호출하는 콜백 (Phase 1.4 / 3.2 에서 주입).
    # `(state, kind)` 시그니처. kind ∈ {"done","cancelled","error"}.
    on_finished: Optional[Callable[["BlogTaskState", str], Awaitable[None]]] = field(
        default=None, repr=False,
    )

    @property
    def elapsed_s(self) -> float:
        end = self.finished_at or datetime.now(timezone.utc)
        return (end - self.started_at).total_seconds()

    @property
    def last_event_age_s(self) -> float:
        return (datetime.now(timezone.utc) - self.last_event_at).total_seconds()

    def progress_hint(self) -> str:
        """tool_call 패턴에서 단순 휴리스틱으로 한 줄 hint 추출."""
        if self.status == "done":
            return "완료"
        if self.status == "cancelled":
            return "취소됨"
        if self.status == "error":
            return "오류"
        if not self.tool_call_counts:
            return "준비 중"
        top = max(self.tool_call_counts.items(), key=lambda kv: kv[1])
        return f"{top[0]} 단계 (호출 {top[1]}회)"

    def estimated_completion(self) -> str:
        # 단순 휴리스틱: tool 호출 패턴이 mutation (post_*, image_*) 로 가면
        # "soon", search/read 위주면 "mid"
        write_like = sum(
            n for k, n in self.tool_call_counts.items()
            if any(k.startswith(p) for p in ("post_", "image_", "tag_", "category_"))
        )
        read_like = sum(
            n for k, n in self.tool_call_counts.items()
            if any(k.startswith(p) for p in ("search", "read_", "list_"))
        )
        if write_like > 0 and read_like > 0:
            return "soon"
        if read_like > 0 and write_like == 0:
            return "mid"
        return "long"

    def to_status_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "task_summary": self.task_summary,
            "status": self.status,
            "elapsed_s": round(self.elapsed_s, 1),
            "last_event_age_s": round(self.last_event_age_s, 1),
            "progress_hint": self.progress_hint(),
            "tool_activity": dict(self.tool_call_counts),
            "last_assistant_excerpt": self.last_assistant_chunk[-400:],
            "estimated_completion": self.estimated_completion(),
            "error": self.error,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "blog_session_uid": self.blog_session_uid,
        }


class BlogTaskRegistry:
    """프로세스 내 BlogTaskState 레지스트리 (싱글톤)."""

    def __init__(self) -> None:
        self._tasks: Dict[str, BlogTaskState] = {}
        self._lock = asyncio.Lock()

    # ─── lookup ─────────────────────────────────────────────

    def get(self, task_id: str) -> Optional[BlogTaskState]:
        return self._tasks.get(task_id)

    def list_for_session(
        self,
        geny_session_id: str,
        *,
        active_only: bool = False,
    ) -> List[BlogTaskState]:
        out = [
            t for t in self._tasks.values()
            if t.geny_session_id == geny_session_id
        ]
        if active_only:
            out = [t for t in out if t.status in ("pending", "running")]
        out.sort(key=lambda t: t.started_at)
        return out

    def active_count_for_session(self, geny_session_id: str) -> int:
        return sum(
            1 for t in self._tasks.values()
            if t.geny_session_id == geny_session_id
            and t.status in ("pending", "running")
        )

    # ─── lifecycle ──────────────────────────────────────────

    async def start(
        self,
        *,
        geny_session_id: str,
        blog_session_uid: str,
        user_text: str,
        task_summary: str,
        on_finished: Optional[Callable[["BlogTaskState", str], Awaitable[None]]] = None,
        client_factory: Optional[Callable[[], AsyncBlogAgentClient]] = None,
    ) -> BlogTaskState:
        """task 등록 + pump_task 비동기 시작. 즉시 ``BlogTaskState`` 반환."""
        async with self._lock:
            now = datetime.now(timezone.utc)
            state = BlogTaskState(
                task_id=uuid.uuid4().hex,
                geny_session_id=geny_session_id,
                blog_session_uid=blog_session_uid,
                task_summary=task_summary,
                user_text=user_text,
                status="pending",
                started_at=now,
                last_event_at=now,
                on_finished=on_finished,
            )
            self._tasks[state.task_id] = state
            state.pump_task = asyncio.create_task(
                _pump(state, client_factory or AsyncBlogAgentClient),
                name=f"blog_pump:{state.task_id[:8]}",
            )
            return state

    async def cancel(self, task_id: str) -> bool:
        """task cancel 신호. 이미 끝났으면 False."""
        state = self._tasks.get(task_id)
        if state is None:
            return False
        if state.status not in ("pending", "running"):
            return False
        state.cancel_token.set()
        return True

    def gc(self, *, now: Optional[datetime] = None) -> int:
        """완료/취소/에러 task 중 _GC_AGE 이상 지난 것을 제거. 제거 수 반환."""
        now = now or datetime.now(timezone.utc)
        to_remove = [
            tid for tid, t in self._tasks.items()
            if t.finished_at is not None and (now - t.finished_at) > _GC_AGE
        ]
        for tid in to_remove:
            self._tasks.pop(tid, None)
        return len(to_remove)


# ─── pump 구현 ─────────────────────────────────────────────────────


def _summarize_frame(frame: Frame) -> str:
    if frame.type == "tool_call":
        name = frame.data.get("tool_name", "?")
        return f"tool_call:{name}"
    if frame.type == "tool_result":
        tid = frame.data.get("tool_use_id", "?")
        is_err = frame.data.get("is_error")
        return f"tool_result:{tid}{' (error)' if is_err else ''}"
    if frame.type == "assistant_text":
        text = frame.data.get("text", "")
        snippet = text[:80].replace("\n", " ")
        return f"assistant_text:{snippet}"
    if frame.type == "error":
        return f"error:{frame.data.get('message', '')}"
    if frame.type == "turn_complete":
        usage = frame.data.get("usage") or {}
        return f"turn_complete:in={usage.get('input_tokens', '?')},out={usage.get('output_tokens', '?')}"
    if frame.raw_unknown:
        return f"unknown:{frame.type}"
    return frame.type


async def _pump(
    state: BlogTaskState,
    client_factory: Callable[[], AsyncBlogAgentClient],
) -> None:
    """SSE frame 을 끝까지 소비하면서 BlogTaskState 를 갱신."""
    state.status = "running"
    client = client_factory()
    try:
        async with client:
            stream_iter = client.stream_message(
                state.blog_session_uid,
                state.user_text,
                client_request_id=state.task_id,
            )
            try:
                async for frame in stream_iter:
                    state.last_event_at = datetime.now(timezone.utc)
                    state.frames.append(FrameSummary(
                        ts=state.last_event_at,
                        type=frame.type,
                        summary=_summarize_frame(frame)[:200],
                    ))

                    if frame.type == "assistant_text":
                        text = frame.data.get("text", "")
                        if isinstance(text, str) and text:
                            state.last_assistant_chunk = (
                                state.last_assistant_chunk + text
                            )[-_LAST_TEXT_MAX:]
                    elif frame.type == "tool_call":
                        name = str(frame.data.get("tool_name", "unknown"))
                        state.tool_call_counts[name] = (
                            state.tool_call_counts.get(name, 0) + 1
                        )
                    elif frame.type == "approval_needed":
                        logger.warning(
                            "blog_agent stream emitted approval_needed — "
                            "external API should auto-approve. task=%s",
                            state.task_id,
                        )
                    elif frame.type == "error":
                        state.error = str(frame.data.get("message") or "unknown error")
                        state.final_text = state.last_assistant_chunk
                        state.status = "error"
                        state.finished_at = datetime.now(timezone.utc)
                        await _notify_finished(state, "error")
                        return
                    elif frame.type == "turn_complete":
                        state.final_text = state.last_assistant_chunk
                        state.status = "done"
                        state.finished_at = datetime.now(timezone.utc)
                        await _notify_finished(state, "done")
                        return

                    if state.cancel_token.is_set():
                        await _do_cancel(state, client)
                        return
            finally:
                # generator close 보장
                try:
                    await stream_iter.aclose()  # type: ignore[attr-defined]
                except Exception:
                    pass

        # stream 이 그냥 끝났는데 turn_complete/error 가 안 온 경우 — stale.
        if state.status == "running":
            state.error = "stream ended without turn_complete"
            state.status = "error"
            state.finished_at = datetime.now(timezone.utc)
            await _notify_finished(state, "error")

    except BlogAgentCancelled:
        # cancel 경로는 _do_cancel 에서 status 마감
        if state.status == "running":
            state.status = "cancelled"
            state.finished_at = datetime.now(timezone.utc)
            await _notify_finished(state, "cancelled")
    except BlogAgentHTTPError as exc:
        state.error = f"HTTP {exc.status_code}: {exc.detail}"
        state.status = "error"
        state.finished_at = datetime.now(timezone.utc)
        await _notify_finished(state, "error")
    except BlogAgentTransportError as exc:
        state.error = f"transport: {exc}"
        state.status = "error"
        state.finished_at = datetime.now(timezone.utc)
        await _notify_finished(state, "error")
    except asyncio.CancelledError:
        # 외부 (Geny shutdown 등) cancel
        state.status = "cancelled"
        state.finished_at = datetime.now(timezone.utc)
        await _notify_finished(state, "cancelled")
        raise
    except Exception as exc:  # noqa: BLE001 — pump 가 죽지 않도록 모두 잡고 마감
        logger.exception("blog_agent pump crashed task=%s", state.task_id)
        state.error = f"unexpected: {exc}"
        state.status = "error"
        state.finished_at = datetime.now(timezone.utc)
        try:
            await _notify_finished(state, "error")
        except Exception:
            logger.exception("on_finished hook also crashed task=%s", state.task_id)


async def _do_cancel(state: BlogTaskState, client: AsyncBlogAgentClient) -> None:
    """cancel_token 감지 시 블로그에 cancel 호출 + 상태 마감."""
    try:
        await client.cancel(state.blog_session_uid)
    except BlogAgentError as exc:
        logger.warning(
            "blog_agent cancel HTTP failed (continuing) task=%s err=%s",
            state.task_id, exc,
        )
    state.status = "cancelled"
    state.finished_at = datetime.now(timezone.utc)
    await _notify_finished(state, "cancelled")


async def _notify_finished(state: BlogTaskState, kind: str) -> None:
    # telemetry — best-effort, never blocks the pump
    try:
        from service.telemetry.blog_agent_metrics import record_delegate_complete
        record_delegate_complete(
            geny_session_id=state.geny_session_id,
            blog_session_uid=state.blog_session_uid,
            task_id=state.task_id,
            status=state.status,
            duration_s=state.elapsed_s,
            frame_count=len(state.frames),
            final_text_len=len(state.final_text or ""),
            error=state.error,
        )
    except Exception:
        logger.debug("blog_agent telemetry record_delegate_complete failed", exc_info=True)

    if state.on_finished is None:
        return
    try:
        await state.on_finished(state, kind)
    except Exception:  # noqa: BLE001
        logger.exception(
            "blog_agent on_finished hook raised task=%s kind=%s",
            state.task_id, kind,
        )


# ─── 싱글톤 ─────────────────────────────────────────────────────


_REGISTRY = BlogTaskRegistry()


def get_blog_task_registry() -> BlogTaskRegistry:
    return _REGISTRY
