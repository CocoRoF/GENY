"""AtlassianConfig gating + the extras bag handed to geny-executor.

Pins the ``is_connected`` condition that satisfies
``feature:atlassian_connected`` and the ``executor_extras`` shape consumed by
the executor's atlassian tool family (``ctx.extras["atlassian"]``). The live
API auth is exercised at deploy time against a real site.
"""

from __future__ import annotations

from service.config.sub_config.tools.atlassian_config import AtlassianConfig


_CLOUD = dict(
    base_url="https://acme.atlassian.net",
    email="me@acme.com",
    api_token="ATATT-tok",
)


# ── gating ───────────────────────────────────────────────────────────

def test_connected_with_url_and_token():
    assert AtlassianConfig(**_CLOUD).is_connected() is True


def test_email_is_optional_server_dc_pat():
    assert AtlassianConfig(base_url="https://jira.corp", api_token="pat").is_connected() is True


def test_not_connected_when_incomplete():
    assert AtlassianConfig().is_connected() is False
    assert AtlassianConfig(base_url=_CLOUD["base_url"]).is_connected() is False
    assert AtlassianConfig(api_token="t").is_connected() is False
    assert AtlassianConfig(base_url="   ", api_token="t").is_connected() is False


def test_not_connected_when_disabled():
    assert AtlassianConfig(**_CLOUD, enabled=False).is_connected() is False


# ── executor extras bag ──────────────────────────────────────────────

def test_executor_extras_shape_and_trimming():
    cfg = AtlassianConfig(
        base_url=" https://acme.atlassian.net ",
        email=" me@acme.com ",
        api_token=" tok ",
        confluence_base_url=" https://conf.corp ",
    )
    assert cfg.executor_extras() == {
        "base_url": "https://acme.atlassian.net",
        "email": "me@acme.com",
        "api_token": "tok",
        "confluence_base_url": "https://conf.corp",
    }


def test_none_fields_from_auto_form_do_not_break_extras():
    # The settings auto-form saves untouched optional fields as None (not "").
    # Regression: prod 2026-07-16 — confluence_base_url=None made
    # executor_extras() raise inside agent_session's swallowed try, so the
    # tools were registered (gate passed) but the credential bag was never
    # injected → every call failed "not connected".
    cfg = AtlassianConfig(
        base_url="https://acme.atlassian.net",
        email=None,  # type: ignore[arg-type]
        api_token="tok",
        confluence_base_url=None,  # type: ignore[arg-type]
    )
    assert cfg.is_connected() is True
    assert cfg.executor_extras() == {
        "base_url": "https://acme.atlassian.net",
        "email": "",
        "api_token": "tok",
        "confluence_base_url": "",
    }
    assert AtlassianConfig(base_url=None, api_token=None).is_connected() is False  # type: ignore[arg-type]


def test_registered_in_tools_category():
    assert AtlassianConfig.get_config_name() == "atlassian"
    assert AtlassianConfig.get_category() == "tools"
    # Every dataclass field is renderable in the settings auto-form.
    meta_names = {f.name for f in AtlassianConfig.get_fields_metadata()}
    assert meta_names == {"enabled", "base_url", "email", "api_token", "confluence_base_url"}
