"""Phase-1 persistent storage: env-var-aware path resolution.

Every store touched by the persistence pass honours an env var that
docker-compose sets to a named-volume mount point. Without these env
vars the stores fall back to in-repo defaults that live on the
container's writable layer and get wiped by ``docker compose up
--build``. These tests pin the env-var → resolved-path contract so
the named-volume map in the compose files keeps working.
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    """Keep ``Path.home()`` predictable; some resolvers fall back to it."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    yield


def test_tool_preset_store_honours_env(monkeypatch, tmp_path):
    target = tmp_path / "tool_presets"
    monkeypatch.setenv("GENY_TOOL_PRESETS_DIR", str(target))
    from service.tool_preset.store import ToolPresetStore

    store = ToolPresetStore()
    assert store._dir == target
    assert target.exists()


def test_tool_preset_store_fallback_when_unset(monkeypatch, tmp_path):
    monkeypatch.delenv("GENY_TOOL_PRESETS_DIR", raising=False)
    from service.tool_preset.store import ToolPresetStore

    store = ToolPresetStore()
    # Repo default: <repo>/backend/tool_presets
    assert store._dir.name == "tool_presets"


def test_conversation_store_honours_env(monkeypatch, tmp_path):
    target = tmp_path / "chat_conversations"
    monkeypatch.setenv("GENY_CHAT_CONVERSATIONS_DIR", str(target))
    from service.chat.conversation_store import ChatConversationStore

    store = ChatConversationStore()
    assert store._dir == target


def test_inbox_manager_honours_env(monkeypatch, tmp_path):
    target = tmp_path / "chat_conversations"
    monkeypatch.setenv("GENY_CHAT_CONVERSATIONS_DIR", str(target))
    from service.chat.inbox import InboxManager

    inbox = InboxManager()
    assert inbox._dir == target / "inbox"
    assert inbox._dlq_dir == target / "inbox_dlq"


def test_config_manager_honours_env(monkeypatch, tmp_path):
    target = tmp_path / "config_variables"
    monkeypatch.setenv("GENY_CONFIG_VARIABLES_DIR", str(target))
    from service.config.manager import ConfigManager

    mgr = ConfigManager()
    assert Path(mgr.config_dir) == target


def test_credentials_path_honours_env(monkeypatch, tmp_path):
    target = tmp_path / "mcp" / "credentials.json"
    monkeypatch.setenv("GENY_MCP_CREDENTIALS", str(target))
    from service.credentials.install import credentials_path

    assert credentials_path() == target


def test_credentials_path_fallback_when_unset(monkeypatch):
    monkeypatch.delenv("GENY_MCP_CREDENTIALS", raising=False)
    from service.credentials.install import credentials_path

    assert credentials_path() == Path.home() / ".geny" / "credentials.json"
