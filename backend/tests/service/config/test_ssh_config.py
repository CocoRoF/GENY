"""SSHConfig validation + gating + the /api/ssh/test controller.

Pins per-entry validation and duplicate detection, the ``has_valid_servers``
condition that satisfies ``feature:ssh_enabled``, and the test-connection
endpoint's response mapping (the SSH connect itself is mocked — real auth is
exercised at deploy time).
"""

from __future__ import annotations

import sys
import types

import pytest

from service.config.sub_config.tools.ssh_config import SSHConfig


_GOOD = {"name": "prod", "host": "1.2.3.4", "port": 22, "user": "hrjang", "password": "pw"}


# ── validation ───────────────────────────────────────────────────────

def test_valid_server_has_no_errors():
    assert SSHConfig(servers=[dict(_GOOD)]).validate() == []


def test_missing_fields_reported():
    errs = SSHConfig(servers=[{"name": "x", "host": "", "user": ""}]).validate()
    joined = " ".join(errs)
    assert "host is required" in joined
    assert "user is required" in joined
    assert "password or a private key" in joined


def test_key_only_server_is_valid():
    assert SSHConfig(servers=[{"name": "k", "host": "h", "user": "u", "private_key": "PEM"}]).validate() == []


def test_bad_port_reported():
    errs = SSHConfig(servers=[{**_GOOD, "port": 99999}]).validate()
    assert any("port must be" in e for e in errs)


def test_duplicate_names_reported():
    errs = SSHConfig(servers=[dict(_GOOD), dict(_GOOD)]).validate()
    assert any("duplicate name" in e for e in errs)


# ── gating ───────────────────────────────────────────────────────────

def test_has_valid_servers_true_when_enabled_and_valid():
    assert SSHConfig(servers=[dict(_GOOD)], enabled=True).has_valid_servers() is True


def test_has_valid_servers_false_when_disabled():
    assert SSHConfig(servers=[dict(_GOOD)], enabled=False).has_valid_servers() is False


def test_has_valid_servers_false_when_all_invalid():
    assert SSHConfig(servers=[{"name": "x"}], enabled=True).has_valid_servers() is False


def test_has_valid_servers_false_when_empty():
    assert SSHConfig(servers=[], enabled=True).has_valid_servers() is False


# ── registration + category ──────────────────────────────────────────

def test_config_registered_in_tools_category():
    from service.config import get_config_manager

    classes = get_config_manager().get_registered_config_classes()
    assert "ssh" in classes
    assert classes["ssh"].get_category() == "tools"


# ── /api/ssh/test controller ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_ssh_controller_maps_success(monkeypatch):
    from controller.ssh_controller import SSHTestRequest, test_ssh_connection

    captured = {}

    async def fake_test(server, *, connect_timeout):
        captured["server"] = server
        return {"success": True, "latency_ms": 42.0}

    fake_mod = types.ModuleType("geny_executor.tools._ssh")
    fake_mod.ssh_test_connection = fake_test
    monkeypatch.setitem(sys.modules, "geny_executor.tools._ssh", fake_mod)

    body = SSHTestRequest(host="h", port=2222, user="u", password="pw")
    resp = await test_ssh_connection(body, _auth=None)

    assert resp.success is True and resp.latency_ms == 42.0
    # The controller forwards the draft (incl. secret) to the connector only.
    assert captured["server"]["host"] == "h" and captured["server"]["password"] == "pw"


@pytest.mark.asyncio
async def test_ssh_controller_maps_failure(monkeypatch):
    from controller.ssh_controller import SSHTestRequest, test_ssh_connection

    async def fake_test(server, *, connect_timeout):
        return {"success": False, "error": "authentication failed"}

    fake_mod = types.ModuleType("geny_executor.tools._ssh")
    fake_mod.ssh_test_connection = fake_test
    monkeypatch.setitem(sys.modules, "geny_executor.tools._ssh", fake_mod)

    resp = await test_ssh_connection(SSHTestRequest(host="h", user="u"), _auth=None)
    assert resp.success is False and "authentication failed" in resp.error
