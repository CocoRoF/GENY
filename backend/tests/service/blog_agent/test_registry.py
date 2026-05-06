"""BlogTaskRegistry pump_task lifecycle 테스트.

실제 httpx 호출 없이 fake client_factory 를 주입해 frame stream 만 검증.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, List, Optional

import pytest

from service.blog_agent.client import AsyncBlogAgentClient
from service.blog_agent.events import Frame
from service.blog_agent.exceptions import BlogAgentHTTPError, BlogAgentTransportError
from service.blog_agent.registry import (
    BlogTaskRegistry,
    BlogTaskState,
    get_blog_task_registry,
)


class _FakeClient:
    """AsyncBlogAgentClient duck-type. async with + stream_message + cancel."""

    def __init__(
        self,
        frames: Iterable[Frame],
        *,
        on_cancel: Optional[Callable[[str], None]] = None,
        raise_in_stream: Optional[BaseException] = None,
        delay_per_frame_s: float = 0.0,
    ):
        self._frames = list(frames)
        self._raise_in_stream = raise_in_stream
        self._delay = delay_per_frame_s
        self.cancel_calls: List[str] = []
        self._on_cancel = on_cancel

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def stream_message(self, session_uid: str, text: str, *, client_request_id=None):
        if self._raise_in_stream is not None:
            raise self._raise_in_stream
        for f in self._frames:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield f

    async def cancel(self, session_uid: str):
        self.cancel_calls.append(session_uid)
        if self._on_cancel:
            self._on_cancel(session_uid)
        return {"session_uid": session_uid, "cancelled": True, "was_running": True}


def _factory(client: _FakeClient) -> Callable[[], AsyncBlogAgentClient]:
    return lambda: client  # type: ignore[return-value]


# ─── basic happy path ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_done_path_records_final_text_and_calls_hook() -> None:
    frames = [
        Frame(type="assistant_text", data={"text": "hello "}),
        Frame(type="tool_call", data={"tool_name": "image_upload", "tool_use_id": "t1", "tool_input": {}}),
        Frame(type="assistant_text", data={"text": "world"}),
        Frame(type="turn_complete", data={"usage": {"input_tokens": 10}}),
    ]
    client = _FakeClient(frames)
    hook_calls: List[tuple] = []

    async def on_finished(state: BlogTaskState, kind: str) -> None:
        hook_calls.append((state.task_id, kind, state.final_text, state.status))

    reg = BlogTaskRegistry()
    state = await reg.start(
        geny_session_id="g1",
        blog_session_uid="b1",
        user_text="write me a post",
        task_summary="post about X",
        on_finished=on_finished,
        client_factory=_factory(client),
    )
    await state.pump_task

    assert state.status == "done"
    assert state.final_text == "hello world"
    assert state.tool_call_counts == {"image_upload": 1}
    assert state.finished_at is not None
    assert hook_calls == [(state.task_id, "done", "hello world", "done")]


@pytest.mark.asyncio
async def test_error_frame_sets_status_error() -> None:
    frames = [
        Frame(type="assistant_text", data={"text": "starting"}),
        Frame(type="error", data={"message": "kaboom"}),
    ]
    client = _FakeClient(frames)
    hook_kinds: List[str] = []

    async def on_finished(state: BlogTaskState, kind: str) -> None:
        hook_kinds.append(kind)

    reg = BlogTaskRegistry()
    state = await reg.start(
        geny_session_id="g1", blog_session_uid="b1",
        user_text="x", task_summary="x",
        on_finished=on_finished,
        client_factory=_factory(client),
    )
    await state.pump_task

    assert state.status == "error"
    assert state.error == "kaboom"
    assert hook_kinds == ["error"]


@pytest.mark.asyncio
async def test_cancel_token_triggers_blog_cancel_and_marks_cancelled() -> None:
    # 무한히 frame 을 흘리는 stream — cancel_token 으로만 중단됨.
    frames = [Frame(type="assistant_text", data={"text": "..."}) for _ in range(50)]
    client = _FakeClient(frames, delay_per_frame_s=0.01)
    hook_kinds: List[str] = []

    async def on_finished(state: BlogTaskState, kind: str) -> None:
        hook_kinds.append(kind)

    reg = BlogTaskRegistry()
    state = await reg.start(
        geny_session_id="g1", blog_session_uid="b1",
        user_text="x", task_summary="x",
        on_finished=on_finished,
        client_factory=_factory(client),
    )

    # 짧게 기다린 후 cancel
    await asyncio.sleep(0.05)
    cancelled = await reg.cancel(state.task_id)
    assert cancelled is True
    await state.pump_task

    assert state.status == "cancelled"
    assert client.cancel_calls == ["b1"]
    assert hook_kinds == ["cancelled"]


@pytest.mark.asyncio
async def test_stream_ends_without_terminal_marks_error() -> None:
    """SSE 가 turn_complete 없이 그냥 끝나면 stale → error."""
    frames = [Frame(type="assistant_text", data={"text": "half"})]
    client = _FakeClient(frames)
    reg = BlogTaskRegistry()
    state = await reg.start(
        geny_session_id="g1", blog_session_uid="b1",
        user_text="x", task_summary="x",
        client_factory=_factory(client),
    )
    await state.pump_task
    assert state.status == "error"
    assert "without turn_complete" in (state.error or "")


@pytest.mark.asyncio
async def test_http_error_in_stream_marks_error() -> None:
    client = _FakeClient(
        [], raise_in_stream=BlogAgentHTTPError(401, "bad key", url="https://x"),
    )
    reg = BlogTaskRegistry()
    state = await reg.start(
        geny_session_id="g1", blog_session_uid="b1",
        user_text="x", task_summary="x",
        client_factory=_factory(client),
    )
    await state.pump_task
    assert state.status == "error"
    assert "401" in (state.error or "")


@pytest.mark.asyncio
async def test_status_dict_shape() -> None:
    frames = [
        Frame(type="tool_call", data={"tool_name": "post_create", "tool_use_id": "1", "tool_input": {}}),
        Frame(type="turn_complete", data={"usage": {}}),
    ]
    client = _FakeClient(frames)
    reg = BlogTaskRegistry()
    state = await reg.start(
        geny_session_id="g1", blog_session_uid="b1",
        user_text="x", task_summary="x",
        client_factory=_factory(client),
    )
    await state.pump_task
    d = state.to_status_dict()
    for key in (
        "task_id", "status", "elapsed_s", "last_event_age_s", "progress_hint",
        "tool_activity", "estimated_completion", "started_at", "finished_at",
    ):
        assert key in d
    assert d["status"] == "done"
    assert d["tool_activity"] == {"post_create": 1}


# ─── registry helpers ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_active_count_for_session_tracks_running() -> None:
    # delay 로 진행 중 상태를 잠깐 유지
    frames = [Frame(type="assistant_text", data={"text": "..."}) for _ in range(20)]
    client_a = _FakeClient(list(frames), delay_per_frame_s=0.01)
    client_b = _FakeClient(list(frames), delay_per_frame_s=0.01)

    reg = BlogTaskRegistry()
    s1 = await reg.start(
        geny_session_id="g1", blog_session_uid="b1",
        user_text="x", task_summary="x", client_factory=_factory(client_a),
    )
    s2 = await reg.start(
        geny_session_id="g1", blog_session_uid="b2",
        user_text="x", task_summary="x", client_factory=_factory(client_b),
    )

    await asyncio.sleep(0.02)
    assert reg.active_count_for_session("g1") == 2

    # cancel 양쪽
    await reg.cancel(s1.task_id)
    await reg.cancel(s2.task_id)
    await s1.pump_task
    await s2.pump_task

    assert reg.active_count_for_session("g1") == 0


@pytest.mark.asyncio
async def test_gc_removes_old_finished_tasks() -> None:
    frames = [Frame(type="turn_complete", data={"usage": {}})]
    client = _FakeClient(frames)
    reg = BlogTaskRegistry()
    state = await reg.start(
        geny_session_id="g1", blog_session_uid="b1",
        user_text="x", task_summary="x", client_factory=_factory(client),
    )
    await state.pump_task

    # finished_at 을 인위적으로 25시간 전으로 옮긴다
    state.finished_at = datetime.now(timezone.utc) - timedelta(hours=25)
    removed = reg.gc()
    assert removed == 1
    assert reg.get(state.task_id) is None


def test_singleton_is_stable() -> None:
    a = get_blog_task_registry()
    b = get_blog_task_registry()
    assert a is b
