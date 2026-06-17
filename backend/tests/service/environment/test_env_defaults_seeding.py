"""Audit 2026-06-17 (C5 + C6) — server-side env-defaults seeding.

env-defaults curation used to be applied only by the FE draft seeder, so
environments created via the API / a preset / any non-draft path silently
ignored the host's ★ defaults. ``EnvironmentService._apply_env_defaults``
now applies the same curation server-side for every non-override create
path:

  * host_selections.{hooks, skills, permissions} — id lists (narrow).
  * tools.external — custom_tools ★ names (C6).

Uncurated (empty) lists leave the manifest's wildcard untouched.
``mcp_servers`` is intentionally NOT seeded here (declarative; FE owns it).
"""

from __future__ import annotations

import pytest

pytest.importorskip("geny_executor")

from geny_executor.core.environment import EnvironmentManifest  # noqa: E402

import service.env_defaults.service as env_defaults_mod  # noqa: E402
from service.environment.service import EnvironmentService  # noqa: E402


class _FakeEnvDefaults:
    """Stand-in for EnvDefaultsService with a fixed curation set."""

    def __init__(self, mapping):
        self._mapping = mapping

    def get_all(self):
        return dict(self._mapping)


@pytest.fixture
def svc(tmp_path) -> EnvironmentService:
    s = EnvironmentService(storage_path=str(tmp_path))
    # _apply_env_defaults is a no-op when app_db is None; give it a
    # truthy sentinel so the seeding branch runs (the fake service
    # ignores the value).
    s._app_db = object()
    return s


def _patch_defaults(monkeypatch, mapping) -> None:
    monkeypatch.setattr(
        env_defaults_mod,
        "EnvDefaultsService",
        lambda _app_db: _FakeEnvDefaults(mapping),
    )


def test_seeds_host_selections_from_curated_defaults(svc, monkeypatch) -> None:
    _patch_defaults(
        monkeypatch,
        {
            "hooks": ["pre_tool_use::echo hi"],
            "skills": ["verify", "debug"],
            "permissions": ["Bash::*::allow"],
            "mcp_servers": [],
            "custom_tools": [],
        },
    )
    m = EnvironmentManifest.blank_manifest("t")
    # blank manifest starts wildcard
    assert m.host_selections.hooks == ["*"]

    svc._apply_env_defaults(m)

    assert m.host_selections.hooks == ["pre_tool_use::echo hi"]
    assert m.host_selections.skills == ["verify", "debug"]
    assert m.host_selections.permissions == ["Bash::*::allow"]


def test_empty_defaults_leave_wildcard(svc, monkeypatch) -> None:
    _patch_defaults(
        monkeypatch,
        {"hooks": [], "skills": [], "permissions": [], "custom_tools": []},
    )
    m = EnvironmentManifest.blank_manifest("t")
    svc._apply_env_defaults(m)
    # uncurated → manifest keeps its wildcard (every host registration)
    assert m.host_selections.hooks == ["*"]
    assert m.host_selections.skills == ["*"]
    assert m.host_selections.permissions == ["*"]


def test_seeds_custom_tools_into_tools_external(svc, monkeypatch) -> None:
    _patch_defaults(
        monkeypatch,
        {"custom_tools": ["my_http_tool", "my_py_tool"]},
    )
    m = EnvironmentManifest.blank_manifest("t")
    assert list(m.tools.external or []) == []

    svc._apply_env_defaults(m)

    assert "my_http_tool" in m.tools.external
    assert "my_py_tool" in m.tools.external


def test_custom_tools_seed_is_a_union_not_a_replace(svc, monkeypatch) -> None:
    _patch_defaults(monkeypatch, {"custom_tools": ["star_tool"]})
    m = EnvironmentManifest.blank_manifest("t")
    m.tools.external = ["preset_tool"]

    svc._apply_env_defaults(m)

    assert "preset_tool" in m.tools.external  # preset pick preserved
    assert "star_tool" in m.tools.external    # ★ default added


def test_no_app_db_is_a_noop(tmp_path) -> None:
    s = EnvironmentService(storage_path=str(tmp_path))
    s._app_db = None
    m = EnvironmentManifest.blank_manifest("t")
    # Should not raise and should not mutate anything.
    s._apply_env_defaults(m)
    assert m.host_selections.hooks == ["*"]


def test_create_from_preset_applies_defaults(svc, monkeypatch) -> None:
    """End-to-end: a preset-created env honours the host ★ set."""
    _patch_defaults(monkeypatch, {"skills": ["verify"]})

    # Find any registered preset name; skip if the build ships none.
    from service.environment.service import _PRESET_FACTORIES

    if not _PRESET_FACTORIES:
        pytest.skip("no preset factories registered in this build")
    preset_name = next(iter(_PRESET_FACTORIES))

    env_id = svc.create_from_preset(preset_name, name="preset env")
    manifest = svc.load_manifest(env_id)
    assert manifest is not None
    assert manifest.host_selections.skills == ["verify"]
