"""Per-environment **tool settings** — a schema-driven config layer for tools.

This is the generalized settings system for tool-related configuration: a tool
that needs per-environment options (a web-search backend + API keys, an external
service base URL, …) declares a :class:`ToolSettingSchema`. The schema then:

  * renders a form in the environment editor (Settings → Tool Settings), and
  * its saved values are stored on the environment manifest under
    ``host_selections.extras["tool_settings"][<key>]`` (per environment,
    round-tripped losslessly by geny-executor), and
  * injected into the session's ``ToolContext.extras[<key>]`` at session build,
    so the tool reads them via ``ctx.extras[<key>]``.

The schema ``key`` IS the ``ctx.extras`` key the tool reads — e.g. the web-search
tool reads ``ctx.extras["web_search"]``, so its schema key is ``"web_search"``.

Field metadata reuses :class:`service.config.base.ConfigField` / ``FieldType`` so
the frontend renders these forms with the same components as global config.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Type

from service.config.base import ConfigField

# Keys that must never be shadowed by a tool-setting (reserved runtime handles
# placed on ToolContext.extras by the session builder).
RESERVED_EXTRAS_KEYS = frozenset(
    {
        "workspace_stack",
        "task_registry",
        "task_runner",
        "cron_store",
        "cron_runner",
        "agent_orchestrator",
        "subagent_manager",
        "mcp_manager",
        "mcp_config",
        "notification_endpoints",
    }
)

_registry: Dict[str, Type["ToolSettingSchema"]] = {}


def register_tool_setting(cls: Type["ToolSettingSchema"]) -> Type["ToolSettingSchema"]:
    """Class decorator: register a tool-setting schema by its key."""
    key = cls.get_key()
    if key in RESERVED_EXTRAS_KEYS:
        raise ValueError(
            f"tool-setting key '{key}' collides with a reserved ToolContext.extras key"
        )
    _registry[key] = cls
    return cls


class ToolSettingSchema(ABC):
    """Declares the per-environment settings for one tool (or tool family).

    Subclass + ``@register_tool_setting`` + implement ``get_key`` /
    ``get_display_name`` / ``get_fields``. Everything else has sensible defaults.
    """

    @classmethod
    @abstractmethod
    def get_key(cls) -> str:
        """Stable key — also the ``ctx.extras`` key the tool reads (e.g. ``web_search``)."""

    @classmethod
    @abstractmethod
    def get_display_name(cls) -> str:
        """Human label shown in the UI."""

    @classmethod
    @abstractmethod
    def get_fields(cls) -> List[ConfigField]:
        """The editable fields (reuses the global-config field metadata)."""

    @classmethod
    def get_description(cls) -> str:
        return ""

    @classmethod
    def get_icon(cls) -> str:
        return "settings-2"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        """Locale → {display_name, description, fields: {name: {label, description}}}."""
        return {}

    @classmethod
    def get_setup_guide(cls) -> Dict[str, str]:
        """Optional per-locale Markdown guide (rendered in a modal)."""
        return {}

    # ── derived ──────────────────────────────────────────────────────────

    @classmethod
    def get_schema(cls) -> Dict[str, Any]:
        """Frontend-facing schema (mirrors ``BaseConfig.get_schema`` shape)."""
        schema: Dict[str, Any] = {
            "key": cls.get_key(),
            "display_name": cls.get_display_name(),
            "description": cls.get_description(),
            "icon": cls.get_icon(),
            "fields": [
                {
                    "name": f.name,
                    "type": f.field_type.value,
                    "label": f.label,
                    "description": f.description,
                    "required": f.required,
                    "default": f.default,
                    "placeholder": f.placeholder,
                    "options": f.options,
                    "min": f.min_value,
                    "max": f.max_value,
                    "pattern": f.pattern,
                    "group": f.group,
                    "secure": f.secure,
                    "depends_on": f.depends_on,
                }
                for f in cls.get_fields()
            ],
        }
        i18n = cls.get_i18n()
        if i18n:
            schema["i18n"] = i18n
        guide = cls.get_setup_guide()
        if guide:
            schema["setup_guide"] = guide
        return schema

    @classmethod
    def sanitize(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        """Keep only declared fields with non-empty values (defensive on save/inject)."""
        if not isinstance(values, dict):
            return {}
        names = {f.name for f in cls.get_fields()}
        out: Dict[str, Any] = {}
        for name in names:
            if name not in values:
                continue
            val = values[name]
            if val is None or (isinstance(val, str) and val.strip() == ""):
                continue
            out[name] = val
        return out


def get_tool_setting_registry() -> Dict[str, Type[ToolSettingSchema]]:
    return dict(_registry)


def get_tool_setting_schemas() -> List[Dict[str, Any]]:
    """All registered schemas as frontend JSON, sorted by key for stable UI order."""
    return [cls.get_schema() for _, cls in sorted(_registry.items())]


def sanitize_tool_settings(raw: Any) -> Dict[str, Dict[str, Any]]:
    """Normalize a ``tool_settings`` map: drop unknown keys + empty field values.

    Used both when persisting (controller/manifest) and when injecting into
    ``ctx.extras`` so a stray key can never reach a tool or shadow a reserved
    runtime handle.
    """
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for key, cls in _registry.items():
        if key not in raw:
            continue
        cleaned = cls.sanitize(raw.get(key) or {})
        if cleaned:
            out[key] = cleaned
    return out
