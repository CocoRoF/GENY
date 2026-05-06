"""blog_agent_tools.py 단위 테스트.

config gate, error 응답, status / cancel 권한 검사를 검증.
실제 HTTP 호출은 monkeypatch 로 우회.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, List, Optional

import pytest


# ─── 가짜 BlogAgentConfig 주입 헬퍼 ─────────────────────────────


@dataclass
class _FakeCfg:
    enabled: bool = True
    api_key: str = "k"
    base_url: str = "https://example.test"
    default_model: str = "claude-sonnet-4-6"
    default_timeout_s: float = 60.0
    max_concurrent_per_session: int = 2


@pytest.fixture
def fake_cfg(monkeypatch):
    cfg = _FakeCfg()

    class _Mgr:
        def get_config(self, name):
            return cfg if name == "blog_agent" else None

    def fake_get_mgr():
        return _Mgr()

    monkeypatch.setattr(
        "service.config.manager.get_config_manager", fake_get_mgr,
    )
    return cfg


# ─── disabled gate ──────────────────────────────────────────────


def test_delegate_returns_error_when_disabled(monkeypatch, fake_cfg):
    fake_cfg.enabled = False
    from tools.custom.blog_agent_tools import BlogAgentDelegateTool

    tool = BlogAgentDelegateTool()
    out = tool.run(session_id="g1", task="write me a post", task_summary="X")
    payload = json.loads(out)
    assert "error" in payload
    assert "disabled" in payload["error"].lower()


def test_delegate_returns_error_when_api_key_empty(monkeypatch, fake_cfg):
    fake_cfg.api_key = ""
    from tools.custom.blog_agent_tools import BlogAgentDelegateTool

    out = BlogAgentDelegateTool().run(session_id="g1", task="x", task_summary="x")
    payload = json.loads(out)
    assert "BLOG_AGENT_API_KEY" in payload["error"]


def test_delegate_rejects_empty_task(monkeypatch, fake_cfg):
    from tools.custom.blog_agent_tools import BlogAgentDelegateTool

    out = BlogAgentDelegateTool().run(session_id="g1", task="   ", task_summary="x")
    payload = json.loads(out)
    assert "non-empty" in payload["error"]


def test_list_posts_returns_error_when_disabled(monkeypatch, fake_cfg):
    fake_cfg.enabled = False
    from tools.custom.blog_agent_tools import BlogAgentListPostsTool

    out = BlogAgentListPostsTool().run()
    assert "disabled" in json.loads(out)["error"].lower()


def test_get_post_rejects_empty_slug(monkeypatch, fake_cfg):
    from tools.custom.blog_agent_tools import BlogAgentGetPostTool

    out = BlogAgentGetPostTool().run(slug="")
    assert "non-empty" in json.loads(out)["error"]


# ─── status / cancel 권한 검사 ──────────────────────────────────


def test_status_unknown_task_id_errors(monkeypatch, fake_cfg):
    from tools.custom.blog_agent_tools import BlogAgentStatusTool

    out = BlogAgentStatusTool().run(session_id="g1", task_id="does-not-exist")
    assert "unknown task_id" in json.loads(out)["error"]


def test_status_cross_session_access_denied(monkeypatch, fake_cfg):
    from datetime import datetime, timezone

    from service.blog_agent.registry import BlogTaskState, get_blog_task_registry
    from tools.custom.blog_agent_tools import BlogAgentStatusTool

    reg = get_blog_task_registry()
    state = BlogTaskState(
        task_id="t1", geny_session_id="OTHER", blog_session_uid="b1",
        task_summary="s", user_text="u", status="running",
        started_at=datetime.now(timezone.utc),
        last_event_at=datetime.now(timezone.utc),
    )
    reg._tasks[state.task_id] = state
    try:
        out = BlogAgentStatusTool().run(session_id="g1", task_id="t1")
        assert "다른 세션" in json.loads(out)["error"]
    finally:
        reg._tasks.pop("t1", None)


def test_status_no_tasks_returns_empty(monkeypatch, fake_cfg):
    from tools.custom.blog_agent_tools import BlogAgentStatusTool

    out = BlogAgentStatusTool().run(session_id="brand-new-g")
    payload = json.loads(out)
    assert payload["tasks"] == []


def test_cancel_unknown_task_errors(monkeypatch, fake_cfg):
    from tools.custom.blog_agent_tools import BlogAgentCancelTool

    out = BlogAgentCancelTool().run(session_id="g1", task_id="nope")
    assert "unknown task_id" in json.loads(out)["error"]


def test_cancel_cross_session_denied(monkeypatch, fake_cfg):
    from datetime import datetime, timezone

    from service.blog_agent.registry import BlogTaskState, get_blog_task_registry
    from tools.custom.blog_agent_tools import BlogAgentCancelTool

    reg = get_blog_task_registry()
    state = BlogTaskState(
        task_id="t2", geny_session_id="OTHER", blog_session_uid="b1",
        task_summary="s", user_text="u", status="running",
        started_at=datetime.now(timezone.utc),
        last_event_at=datetime.now(timezone.utc),
    )
    reg._tasks[state.task_id] = state
    try:
        out = BlogAgentCancelTool().run(session_id="g1", task_id="t2")
        assert "다른 세션" in json.loads(out)["error"]
    finally:
        reg._tasks.pop("t2", None)


# ─── TOOLS export shape ─────────────────────────────────────────


def test_tools_export_has_five_tools():
    from tools.custom.blog_agent_tools import TOOLS

    names = {t.name for t in TOOLS}
    assert names == {
        "blog_agent_delegate",
        "blog_agent_status",
        "blog_agent_cancel",
        "blog_agent_list_posts",
        "blog_agent_get_post",
    }


def test_all_tools_declare_capabilities():
    from tools.custom.blog_agent_tools import TOOLS

    for tool in TOOLS:
        assert tool.CAPABILITIES is not None
