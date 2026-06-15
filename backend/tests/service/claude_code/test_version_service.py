"""Claude Code version-management logic (npm/claude shell-outs mocked)."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest


def _run_coro(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture
def svc(tmp_path, monkeypatch):
    from service.claude_code import version_service as vs
    monkeypatch.setattr(vs, "_PIN_PATH", tmp_path / "claude_code_version.json")
    state = {"installed": "1.0.0", "latest": "1.5.0"}

    async def fake_run(cmd, timeout):
        if "claude" in cmd and "--version" in cmd:
            return (0, f"{state['installed']} (Claude Code)\n", "")
        if "view" in cmd:
            return (0, state["latest"] + "\n", "")
        if "install" in cmd:
            spec = cmd[-1]
            ver = spec.split("@")[-1]
            state["installed"] = state["latest"] if ver == "latest" else ver
            return (0, "", "")
        if "ls" in cmd:
            return (0, '{"dependencies":{}}', "")
        return (1, "", "unknown cmd")

    monkeypatch.setattr(vs, "_run", fake_run)
    return vs, state


def test_status_reports_update_available(svc):
    vs, _ = svc
    st = _run_coro(vs.status())
    assert st["current"] == "1.0.0"
    assert st["latest"] == "1.5.0"
    assert st["update_available"] is True
    assert st["can_rollback"] is False


def test_update_latest_records_pin_and_history(svc):
    vs, state = svc
    r = _run_coro(vs.install("latest"))
    assert r == {"ok": True, "installed": "1.5.0", "previous": "1.0.0"}
    st = _run_coro(vs.status())
    assert st["current"] == "1.5.0"
    assert st["pinned"] == "latest"
    assert st["previous"] == "1.0.0"
    assert st["history"] == ["1.0.0"]
    assert st["can_rollback"] is True


def test_install_specific_then_rollback(svc):
    vs, state = svc
    _run_coro(vs.install("latest"))      # 1.0.0 -> 1.5.0
    _run_coro(vs.install("2.0.0"))       # 1.5.0 -> 2.0.0
    st = _run_coro(vs.status())
    assert st["current"] == "2.0.0"
    assert st["previous"] == "1.5.0"
    assert st["history"] == ["1.5.0", "1.0.0"]

    r = _run_coro(vs.rollback())         # back to previous 1.5.0
    assert r["ok"] is True
    assert state["installed"] == "1.5.0"


def test_invalid_version_rejected(svc):
    vs, _ = svc
    r = _run_coro(vs.install("not-a-version"))
    assert r["ok"] is False


def test_rollback_without_history_fails(svc):
    vs, _ = svc
    r = _run_coro(vs.rollback())
    assert r["ok"] is False


def test_apply_pin_on_boot_reinstalls_specific(svc):
    vs, state = svc
    _run_coro(vs.install("2.0.0"))       # pin -> 2.0.0
    state["installed"] = "9.9.9"         # simulate fresh image with different version
    _run_coro(vs.apply_pin_on_boot())    # should reinstall the pinned 2.0.0
    assert state["installed"] == "2.0.0"


def test_apply_pin_on_boot_noop_without_pin(svc):
    vs, state = svc
    state["installed"] = "3.3.3"
    _run_coro(vs.apply_pin_on_boot())    # no pin file → leave as-is
    assert state["installed"] == "3.3.3"
