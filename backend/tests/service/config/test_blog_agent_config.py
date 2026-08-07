"""BlogAgentConfig — 등록 / 필드 / 모델 옵션 sanity 테스트.

핵심 invariants:
  * BaseConfig 자동 발견에 등록되어 있다 (`get_registered_configs`)
  * default_model 은 SELECT 이고 옵션은 blog frontend AVAILABLE_MODELS 와
    일치한다 (한 곳에서만 갱신하면 두 쪽 모두 따라가는 패턴)
  * 8개 필드가 모두 존재 + secure 필드는 api_key 만
  * apply_change 가 매 필드에 연결되어 있어 settings UI 에서 .env / os.environ
    이 즉시 반영된다
"""
from __future__ import annotations

from service.config.base import FieldType, get_registered_configs
from service.config.sub_config.general.blog_agent_config import (
    BLOG_AGENT_MODEL_OPTIONS,
    BlogAgentConfig,
)


# ─── 등록 ────────────────────────────────────────────────────────


def test_blog_agent_is_registered_in_global_registry() -> None:
    registry = get_registered_configs()
    assert "blog_agent" in registry
    assert registry["blog_agent"] is BlogAgentConfig


def test_category_is_tools() -> None:
    # Lives under sub_config/general/ on disk, but is filed under the
    # "tools" group in the settings UI.
    assert BlogAgentConfig.get_category() == "tools"


def test_display_name_visible_in_ui() -> None:
    assert BlogAgentConfig.get_display_name() == "Blog Agent"


# ─── 모델 옵션 — blog frontend 와 동기화 ───────────────────────


def test_model_options_mirror_blog_frontend_available_models() -> None:
    """blog 의 frontend AVAILABLE_MODELS (3종) 와 1:1 동기화.

    blog 가 새 모델을 추가하면 BLOG_AGENT_MODEL_OPTIONS 도 함께 갱신해야
    함을 강제 — frontend 파일이 같은 repo 에 없으므로 값 자체로 lock-in.
    """
    values = [opt["value"] for opt in BLOG_AGENT_MODEL_OPTIONS]
    assert values == [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
    ]
    for opt in BLOG_AGENT_MODEL_OPTIONS:
        assert "label" in opt and opt["label"]


def test_default_model_is_in_options() -> None:
    """default 가 옵션 리스트에 들어있어야 SELECT 가 미리 채워져 보임."""
    cfg = BlogAgentConfig.get_default_instance()
    values = [opt["value"] for opt in BLOG_AGENT_MODEL_OPTIONS]
    assert cfg.default_model in values


# ─── 필드 metadata ───────────────────────────────────────────────


def test_every_field_is_present_in_metadata() -> None:
    fields = BlogAgentConfig.get_fields_metadata()
    names = {f.name for f in fields}
    assert names == {
        "base_url",
        "api_key",
        "default_model",
        "default_prompt_mode",
        "default_timeout_s",
        "pump_idle_grace_s",
        "enabled",
        "enabled_for_subworkers",
        "max_concurrent_per_session",
    }


def test_default_model_field_is_select_with_options() -> None:
    fields = {f.name: f for f in BlogAgentConfig.get_fields_metadata()}
    field = fields["default_model"]
    assert field.field_type == FieldType.SELECT
    assert field.options == BLOG_AGENT_MODEL_OPTIONS


def test_api_key_is_secure_password_field() -> None:
    fields = {f.name: f for f in BlogAgentConfig.get_fields_metadata()}
    field = fields["api_key"]
    assert field.field_type == FieldType.PASSWORD
    assert field.secure is True


def test_only_api_key_is_secure() -> None:
    fields = BlogAgentConfig.get_fields_metadata()
    secure_names = {f.name for f in fields if f.secure}
    assert secure_names == {"api_key"}


def test_base_url_is_url_field() -> None:
    fields = {f.name: f for f in BlogAgentConfig.get_fields_metadata()}
    assert fields["base_url"].field_type == FieldType.URL


def test_boolean_toggles_are_boolean_fields() -> None:
    fields = {f.name: f for f in BlogAgentConfig.get_fields_metadata()}
    assert fields["enabled"].field_type == FieldType.BOOLEAN
    assert fields["enabled_for_subworkers"].field_type == FieldType.BOOLEAN


def test_numeric_fields_have_min_max_bounds() -> None:
    fields = {f.name: f for f in BlogAgentConfig.get_fields_metadata()}
    for name in (
        "default_timeout_s",
        "pump_idle_grace_s",
        "max_concurrent_per_session",
    ):
        f = fields[name]
        assert f.field_type == FieldType.NUMBER, name
        assert f.min_value is not None, name
        assert f.max_value is not None, name
        assert f.min_value < f.max_value, name


def test_every_field_has_apply_change_callback() -> None:
    """settings UI 가 값을 바꿀 때 os.environ 이 즉시 업데이트되도록 모든
    필드가 env_sync 콜백을 달고 있어야 한다."""
    for f in BlogAgentConfig.get_fields_metadata():
        assert f.apply_change is not None, f.name


def test_fields_grouped_into_three_logical_sections() -> None:
    """connection / behavior / access — i18n groups 와 일치."""
    fields = BlogAgentConfig.get_fields_metadata()
    groups = {f.group for f in fields}
    assert groups == {"connection", "behavior", "access"}


# ─── i18n 동기화 ─────────────────────────────────────────────────


def test_korean_i18n_covers_all_fields() -> None:
    i18n = BlogAgentConfig.get_i18n()["ko"]
    field_names = {f.name for f in BlogAgentConfig.get_fields_metadata()}
    i18n_names = set(i18n["fields"].keys())
    assert field_names == i18n_names


def test_korean_i18n_covers_all_groups() -> None:
    i18n = BlogAgentConfig.get_i18n()["ko"]
    field_groups = {f.group for f in BlogAgentConfig.get_fields_metadata()}
    i18n_groups = set(i18n["groups"].keys())
    assert field_groups == i18n_groups
