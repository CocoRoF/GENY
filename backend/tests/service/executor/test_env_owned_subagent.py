"""Env-driven owned sub-agent (2026-06-18): ownership is declared by the
environment (host_selections.extras.owned_subagent), not hardcoded to
role==VTUBER. The vtuber env templates declare it; the worker env doesn't.
"""

from __future__ import annotations

import types

import pytest

pytest.importorskip("geny_executor")

from geny_executor.core.environment import EnvironmentManifest  # noqa: E402
from service.executor.agent_session_manager import AgentSessionManager  # noqa: E402


def _mgr_with_env(manifest):
    mgr = object.__new__(AgentSessionManager)
    mgr._environment_service = types.SimpleNamespace(
        load_manifest=lambda env_id: manifest
    )
    return mgr


def test_env_owned_subagent_reads_extras():
    m = EnvironmentManifest.blank_manifest("e")
    m.host_selections.extras["owned_subagent"] = {"enabled": True}
    mgr = _mgr_with_env(m)
    assert mgr._env_owned_subagent("e") == {"enabled": True}


def test_env_owned_subagent_none_when_absent():
    m = EnvironmentManifest.blank_manifest("e")
    mgr = _mgr_with_env(m)
    assert mgr._env_owned_subagent("e") is None


def test_env_owned_subagent_none_when_no_env():
    mgr = _mgr_with_env(None)
    assert mgr._env_owned_subagent("missing") is None


def test_vtuber_template_declares_owned_subagent_worker_does_not():
    from service.environment.templates import create_vtuber_env, create_worker_env

    assert create_vtuber_env().host_selections.extras.get("owned_subagent") == {
        "enabled": True
    }
    assert create_worker_env().host_selections.extras.get("owned_subagent") is None
