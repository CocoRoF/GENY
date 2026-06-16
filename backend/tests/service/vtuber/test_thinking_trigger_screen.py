"""Screen-observation as a first-class trigger CATEGORY.

The proactive screen commentary is driven by the trigger-preset system (트리거
관리), not a hardcoded prompt: a category with ``requires_screen_active=True`` is
only eligible while the user shares their screen, and when it fires the runtime
attaches the live frame so the persona reacts to what's on screen. The prompt
text comes from the (editable) preset. Categories without that flag behave
exactly as before — text-only, no attachment.
"""

from __future__ import annotations

import pytest

from service.trigger_preset.schemas import TriggerCategory


def _patch_common(monkeypatch, svc, *, category: TriggerCategory, prompt: str) -> dict:
    """Stub everything _fire_trigger touches except the screen path; pin which
    category/prompt the roulette 'chose'. Returns the execute_command capture."""
    monkeypatch.setattr(svc, "_safe_inbox_unread_count", lambda _sid: 0)
    monkeypatch.setattr(svc, "_pick_category_and_prompt", lambda _sid, _fn: (prompt, category))
    monkeypatch.setattr(svc, "_save_to_chat_room", lambda _sid, _r: None)

    captured: dict = {}

    import service.execution.agent_executor as exec_mod

    async def _fake_exec(session_id, prompt, **kwargs):  # noqa: ANN001
        captured["session_id"] = session_id
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs

        class _R:
            success = True
            output = "사장님, 그 import 에러 거기서 막히셨네요?"

        return _R()

    monkeypatch.setattr(exec_mod, "execute_command", _fake_exec)
    return captured


_SCREEN_CAT = TriggerCategory(
    id="screen_observation", label="화면 관찰", requires_screen_active=True, weight=800.0,
)
_IDLE_CAT = TriggerCategory(id="first_idle", label="첫 침묵", weight=55.0)


@pytest.mark.asyncio
async def test_screen_category_attaches_live_frame(monkeypatch) -> None:
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    captured = _patch_common(
        monkeypatch, svc, category=_SCREEN_CAT,
        prompt="[THINKING_TRIGGER:screen_observation] 화면 보고 반응해",
    )

    fake_frame = {"kind": "image", "mime_type": "image/jpeg", "data": "QUJD", "source": "screen_observation"}

    async def _fake_capture(_sid):
        return fake_frame

    monkeypatch.setattr(so, "capture_current_screen_attachment", _fake_capture)

    await svc._fire_trigger("sid-1")

    assert captured["kwargs"].get("attachments") == [fake_frame]
    assert captured["kwargs"]["is_trigger"] is True
    # Prompt is verbatim from the preset — no hardcoded suffix appended.
    assert captured["prompt"] == "[THINKING_TRIGGER:screen_observation] 화면 보고 반응해"


@pytest.mark.asyncio
async def test_non_screen_category_never_captures(monkeypatch) -> None:
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    captured = _patch_common(
        monkeypatch, svc, category=_IDLE_CAT,
        prompt="[THINKING_TRIGGER:first_idle] 잠깐 생각",
    )

    async def _should_not_run(_sid):
        raise AssertionError("captured screen for a non-screen category")

    monkeypatch.setattr(so, "capture_current_screen_attachment", _should_not_run)

    await svc._fire_trigger("sid-2")

    assert "attachments" not in captured["kwargs"]


@pytest.mark.asyncio
async def test_screen_category_skips_fire_when_no_frame(monkeypatch) -> None:
    """Screen category chosen but the connector returned no frame → skip the
    fire entirely (don't send a screen prompt the persona can't ground)."""
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    captured = _patch_common(
        monkeypatch, svc, category=_SCREEN_CAT,
        prompt="[THINKING_TRIGGER:screen_observation] 화면 보고 반응해",
    )

    async def _no_frame(_sid):
        return None

    monkeypatch.setattr(so, "capture_current_screen_attachment", _no_frame)

    await svc._fire_trigger("sid-3")

    assert captured == {}  # execute_command never called


def test_default_manifest_has_screen_category() -> None:
    """The bundled default (what '새 드래프트' clones) carries the screen
    category gated on screen-active, with prompts — so it's editable in the UI."""
    from service.trigger_preset.defaults import default_manifest

    m = default_manifest()
    screen = next((c for c in m.categories if c.id == "screen_observation"), None)
    assert screen is not None
    assert screen.requires_screen_active is True
    assert screen.prompt_refs  # references real prompts
    ids = {p.id for p in m.prompts}
    assert all(r.prompt_id in ids for r in screen.prompt_refs)


def test_screen_category_eligibility_gated_on_active() -> None:
    from service.vtuber.thinking_trigger import _category_eligible

    def _elig(active: bool) -> bool:
        return _category_eligible(
            _SCREEN_CAT, consec=0, sub_worker_busy=False, sub_worker_linked=False,
            time_window="afternoon", last_fire_at=0.0, now=10_000.0, screen_active=active,
        )

    assert _elig(True) is True
    assert _elig(False) is False


# ── scan_all: screen-active union + backoff bypass ────────────────────


@pytest.mark.asyncio
async def test_scan_fires_screen_active_session_not_in_activity(monkeypatch) -> None:
    """A screen-sharing session that was never registered via a normal turn
    (e.g. lazily rehydrated after a restart) still gets scanned + fired."""
    from unittest.mock import AsyncMock
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    svc._fire_trigger = AsyncMock()  # type: ignore[assignment]
    monkeypatch.setattr(svc, "_safe_inbox_unread_count", lambda _sid: 0)
    monkeypatch.setattr(so, "list_active_sessions", lambda: ["sid-screen"])

    assert "sid-screen" not in svc._activity   # never registered
    await svc.scan_all()
    svc._fire_trigger.assert_awaited_once_with("sid-screen")


@pytest.mark.asyncio
async def test_screen_active_bypasses_adaptive_backoff(monkeypatch) -> None:
    """A high consecutive-trigger count would push the adaptive threshold toward
    max_idle (~1h); while sharing the screen we ignore it and use base_idle."""
    import time
    from unittest.mock import AsyncMock
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    svc._fire_trigger = AsyncMock()  # type: ignore[assignment]
    monkeypatch.setattr(svc, "_safe_inbox_unread_count", lambda _sid: 0)
    monkeypatch.setattr(so, "list_active_sessions", lambda: ["sid"])

    svc._activity["sid"] = time.time() - 120     # idle 120s
    svc._consecutive_triggers["sid"] = 100       # adaptive threshold would be ~3600s
    # Sanity: without the bypass this would NOT fire.
    assert svc._get_adaptive_threshold("sid") > 120

    await svc.scan_all()
    svc._fire_trigger.assert_awaited_once_with("sid")   # fired anyway (base_idle 60 < 120)


@pytest.mark.asyncio
async def test_fire_falls_back_to_cached_upload_when_ws_grab_none(monkeypatch) -> None:
    """WS live-grab returns None (connector doesn't implement it) → use the
    most recent UPLOADED frame so the screen comment still fires."""
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so

    svc = ThinkingTriggerService()
    captured = _patch_common(
        monkeypatch, svc, category=_SCREEN_CAT,
        prompt="[THINKING_TRIGGER:screen_observation] 화면 보고 반응해",
    )

    cached = {"kind": "image", "mime_type": "image/jpeg", "data": "Q0FDSEVE", "source": "screen_observation"}

    async def _ws_none(_sid):
        return None

    monkeypatch.setattr(so, "capture_current_screen_attachment", _ws_none)
    monkeypatch.setattr(so, "get_recent_frame_attachment", lambda _sid: cached)

    await svc._fire_trigger("sid-fallback")

    assert captured["kwargs"].get("attachments") == [cached]


# ── fire_screen_now: the "Show Now" forced screen comment (path B) ────


@pytest.mark.asyncio
async def test_fire_screen_now_forces_comment_with_frame(monkeypatch) -> None:
    """The Show-Now button forces an immediate screen comment: renders the
    default manifest's screen_observation category prompt, attaches the frame,
    fires one turn, and marks the screen commented."""
    from unittest.mock import AsyncMock
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so
    from service.trigger_preset import set_trigger_preset_service
    import service.execution.agent_executor as exec_mod

    set_trigger_preset_service(None)  # use the in-code default manifest (has screen cat)
    try:
        svc = ThinkingTriggerService()
        monkeypatch.setattr(svc, "_save_to_chat_room", lambda _sid, _r: None)

        frame = {"kind": "image", "mime_type": "image/jpeg", "data": "QUJD", "source": "screen_observation"}
        async def _grab(_sid):
            return frame
        monkeypatch.setattr(so, "capture_current_screen_attachment", _grab)
        marked: list = []
        monkeypatch.setattr(so, "mark_screen_comment", lambda sid: marked.append(sid))

        captured: dict = {}
        async def _exec(session_id, prompt, **kwargs):
            captured["prompt"] = prompt
            captured["kwargs"] = kwargs
            class _R:
                success = True
                output = "사장님, 그 에러 보여요!"
            return _R()
        monkeypatch.setattr(exec_mod, "execute_command", _exec)

        ok = await svc.fire_screen_now("sid-now")
        assert ok is True
        assert captured["kwargs"].get("attachments") == [frame]
        assert captured["kwargs"]["is_trigger"] is True
        assert "[THINKING_TRIGGER:screen_observation]" in captured["prompt"]
        assert marked == ["sid-now"]
    finally:
        set_trigger_preset_service(None)


@pytest.mark.asyncio
async def test_fire_screen_now_no_frame_returns_false(monkeypatch) -> None:
    from service.vtuber.thinking_trigger import ThinkingTriggerService
    from service.vtuber import screen_observation as so
    from service.trigger_preset import set_trigger_preset_service
    import service.execution.agent_executor as exec_mod

    set_trigger_preset_service(None)
    try:
        svc = ThinkingTriggerService()
        async def _none(_sid):
            return None
        monkeypatch.setattr(so, "capture_current_screen_attachment", _none)
        monkeypatch.setattr(so, "get_recent_frame_attachment", lambda _sid: None)
        async def _exec(*a, **k):
            raise AssertionError("must not fire without a frame")
        monkeypatch.setattr(exec_mod, "execute_command", _exec)
        assert await svc.fire_screen_now("sid-x") is False
    finally:
        set_trigger_preset_service(None)
