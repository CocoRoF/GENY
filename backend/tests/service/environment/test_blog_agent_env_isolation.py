"""BLOG_AGENT_DELEGATION_PLAN.md § Phase 4 — env 분리 회귀 테스트.

  - VTuber env: 5개 blog_agent_* 도구가 모두 노출되어야 함
  - Worker env: 5개가 모두 빠져 있어야 함 (default — enabled_for_subworkers=False)
  - enabled_for_subworkers=True 일 때만 Worker env 에 다시 들어옴
"""
from __future__ import annotations

from typing import Iterable, Optional


_BLOG_TOOLS = [
    "blog_agent_delegate",
    "blog_agent_status",
    "blog_agent_cancel",
    "blog_agent_list_posts",
    "blog_agent_get_post",
]


class _FakeToolLoader:
    def __init__(self, source_map: dict[str, str]):
        self._source = source_map

    def get_tool_source(self, name: str) -> Optional[str]:
        return self._source.get(name)


def _all_names_with_blog_tools() -> list[str]:
    """Worker env 에 들어가는 'all names' 의 일반적인 super-set."""
    return [
        "send_direct_message_internal",
        "send_direct_message_external",
        "read_inbox",
        "memory_read",
        "memory_write",
        "knowledge_search",
        "web_search",
        "web_fetch",
        *_BLOG_TOOLS,
    ]


def test_worker_env_excludes_blog_agent_tools_by_default(monkeypatch) -> None:
    """기본값(BlogAgentConfig.enabled_for_subworkers=False) 에서 Worker env
    의 external 리스트에는 blog_agent_* 가 하나도 없어야 한다."""
    # cfg lookup 이 실패해도 default deny 로 떨어져 동일 결과여야 한다 — 두
    # 케이스 모두 검증하기 위해 명시적으로 False cfg 를 주입.
    class _DisabledCfg:
        enabled_for_subworkers = False

    class _Mgr:
        def get_config(self, name):
            return _DisabledCfg() if name == "blog_agent" else None

    monkeypatch.setattr(
        "service.config.manager.get_config_manager", lambda: _Mgr(),
    )

    from service.environment.templates import create_worker_env

    manifest = create_worker_env(external_tool_names=_all_names_with_blog_tools())
    external = list(manifest.tools.external)
    for tool in _BLOG_TOOLS:
        assert tool not in external, f"{tool} leaked into Worker env"


def test_worker_env_includes_blog_agent_tools_when_opted_in(monkeypatch) -> None:
    """enabled_for_subworkers=True 일 때 deny 가 비어 Worker env 가 도구들을
    다시 받아야 한다."""
    class _OptInCfg:
        enabled_for_subworkers = True

    class _Mgr:
        def get_config(self, name):
            return _OptInCfg() if name == "blog_agent" else None

    monkeypatch.setattr(
        "service.config.manager.get_config_manager", lambda: _Mgr(),
    )

    from service.environment.templates import create_worker_env

    manifest = create_worker_env(external_tool_names=_all_names_with_blog_tools())
    external = list(manifest.tools.external)
    for tool in _BLOG_TOOLS:
        assert tool in external, f"{tool} missing despite opt-in"


def test_vtuber_env_includes_blog_agent_tools() -> None:
    """VTuber whitelist 에 5개 도구가 들어가 있어 manifest 에 노출돼야 한다."""
    from service.environment.templates import create_vtuber_env

    loader = _FakeToolLoader({
        "send_direct_message_internal": "geny_tools",
        "read_inbox": "geny_tools",
        "memory_read": "memory_tools",
        # blog_agent_* 는 custom 출처라 stem 이 platform 에 없어도
        # whitelist 매칭으로 통과해야 한다.
    })
    all_names = [
        "send_direct_message_internal",
        "read_inbox",
        "memory_read",
        "browser_navigate",   # 이건 whitelist 에 없으니 제외 검증
        *_BLOG_TOOLS,
    ]
    manifest = create_vtuber_env(all_tool_names=all_names, tool_loader=loader)
    external = list(manifest.tools.external)
    for tool in _BLOG_TOOLS:
        assert tool in external, f"{tool} missing from VTuber env"
    assert "browser_navigate" not in external
