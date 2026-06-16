"""Screen-aware idle reflections in ThinkingTriggerService.

When the user has screen observation ON, an idle [THINKING_TRIGGER] should
attach the live screen frame and bias the reflection toward what's actually on
screen — so the persona reacts to the work instead of generic small-talk. When
observation is OFF (or no frame is available) the trigger behaves exactly as
before: text-only, no attachments.
"""

from __future__ import annotations

import pytest


def _patch_common(monkeypatch, svc) -> dict:
    """Stub everything _fire_trigger touches except the screen path, and
    capture the execute_command call. Returns the capture dict."""
    monkeypatch.setattr(svc, "_safe_inbox_unread_count", lambda _sid: 0)
    monkeypatch.setattr(svc, "_build_trigger_prompt", lambda _sid, _fn: "[THINKING_TRIGGER:x] 잠깐 쉬어가는 생각")
    monkeypatch.setattr(svc, "_save_to_chat_room", lambda _sid, _r: None)

    captured: dict = {}

    import service.execution.agent_executor as exec_mod

    async def _fake_exec(session_id, prompt, **kwargs):  # noqa: ANN001
        captured["session_id"] = session_id
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs

        class _R:
            success = True
            output = "사장님, 그 함수 잘 풀리고 있네요?"

        return _R()

    monkeypatch.setattr(exec_mod, "execute_command", _fake_exec)
    return captured


@pytest.mark.asyncio
async def test_idle_reflection_attaches_screen_when_observation_active(monkeypatch) -> None:
    from service.vtuber.thinking_trigger import ThinkingTriggerService, _SCREEN_REFLECTION_SUFFIX
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    captured = _patch_common(monkeypatch, svc)

    fake_frame = {"kind": "image", "mime_type": "image/jpeg", "data": "QUJD", "source": "screen_observation"}
    monkeypatch.setattr(so, "is_screen_active", lambda _sid: True)

    async def _fake_capture(_sid):
        return fake_frame

    monkeypatch.setattr(so, "capture_current_screen_attachment", _fake_capture)

    await svc._fire_trigger("sid-1")

    # The live frame rode along, and the prompt got the screen-reaction bias.
    assert captured["kwargs"].get("attachments") == [fake_frame]
    assert _SCREEN_REFLECTION_SUFFIX in captured["prompt"]
    assert captured["kwargs"]["is_trigger"] is True


@pytest.mark.asyncio
async def test_idle_reflection_text_only_when_observation_off(monkeypatch) -> None:
    from service.vtuber.thinking_trigger import ThinkingTriggerService, _SCREEN_REFLECTION_SUFFIX
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    captured = _patch_common(monkeypatch, svc)

    monkeypatch.setattr(so, "is_screen_active", lambda _sid: False)

    async def _should_not_run(_sid):  # capture must never be attempted
        raise AssertionError("captured screen despite observation OFF")

    monkeypatch.setattr(so, "capture_current_screen_attachment", _should_not_run)

    await svc._fire_trigger("sid-2")

    assert "attachments" not in captured["kwargs"]
    assert _SCREEN_REFLECTION_SUFFIX not in captured["prompt"]


@pytest.mark.asyncio
async def test_idle_reflection_falls_back_when_no_frame(monkeypatch) -> None:
    """Observation ON but the connector returned no frame (stream gone) →
    proceed text-only, never block the reflection."""
    from service.vtuber.thinking_trigger import ThinkingTriggerService, _SCREEN_REFLECTION_SUFFIX
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    captured = _patch_common(monkeypatch, svc)

    monkeypatch.setattr(so, "is_screen_active", lambda _sid: True)

    async def _no_frame(_sid):
        return None

    monkeypatch.setattr(so, "capture_current_screen_attachment", _no_frame)

    await svc._fire_trigger("sid-3")

    assert "attachments" not in captured["kwargs"]
    assert _SCREEN_REFLECTION_SUFFIX not in captured["prompt"]
