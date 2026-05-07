"""Tests for the PostCaptureHook dispatcher."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import pytest

from service.whiteboard import post_capture_hook
from service.whiteboard.post_capture_hook import (
    clear_hooks_for_tests,
    dispatch_post_capture,
    get_post_capture_hook,
    register_post_capture_hook,
)
from service.whiteboard.types import CaptureEvent, CapturePayload


def _make_event(capture_type: str = "image") -> CaptureEvent:
    return CaptureEvent(
        capture_id="cap-1",
        type=capture_type,  # type: ignore[arg-type]
        source="manual",
        payload=CapturePayload(attachment_path="_attachments/x.png"),
        user_id="alice",
    )


@pytest.fixture(autouse=True)
def _reset_hooks() -> None:
    clear_hooks_for_tests()


def test_register_replaces_previous_hook() -> None:
    async def first(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "first"}

    async def second(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "second"}

    register_post_capture_hook("image", first)
    register_post_capture_hook("image", second)

    assert get_post_capture_hook("image") is second


def test_unregister_callback_removes_only_owner() -> None:
    async def hook_a(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "a"}

    async def hook_b(event: CaptureEvent, _: str) -> Dict[str, Any]:
        return {"who": "b"}

    unregister_a = register_post_capture_hook("image", hook_a)
    register_post_capture_hook("image", hook_b)
    # `unregister_a` shouldn't blow away b — it only owns a.
    unregister_a()
    assert get_post_capture_hook("image") is hook_b


def test_dispatch_returns_none_for_unregistered_type() -> None:
    out = asyncio.new_event_loop().run_until_complete(
        dispatch_post_capture(_make_event("audio"), "x.md")
    )
    assert out is None


def test_dispatch_swallows_hook_exceptions() -> None:
    async def bad(event: CaptureEvent, _: str) -> Dict[str, Any]:
        raise RuntimeError("boom")

    register_post_capture_hook("image", bad)
    out = asyncio.new_event_loop().run_until_complete(
        dispatch_post_capture(_make_event("image"), "x.md")
    )
    assert out is None  # swallowed


def test_dispatch_returns_hook_result() -> None:
    async def fine(
        event: CaptureEvent, draft: str
    ) -> Optional[Dict[str, Any]]:
        return {"got": event.capture_id, "for": draft}

    register_post_capture_hook("screenshot", fine)
    out = asyncio.new_event_loop().run_until_complete(
        dispatch_post_capture(_make_event("screenshot"), "inbox/foo.md")
    )
    assert out == {"got": "cap-1", "for": "inbox/foo.md"}


def test_fire_and_forget_returns_none_outside_loop() -> None:
    # No running loop → no scheduling, no error.
    out = post_capture_hook.fire_and_forget(_make_event(), "x.md")
    assert out is None
