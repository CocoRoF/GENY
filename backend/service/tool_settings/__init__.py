"""Per-environment tool settings (schema-driven, stored on the env manifest).

See :mod:`service.tool_settings.base`. Importing this package auto-registers all
bundled tool-setting schemas (via ``sub_settings``).
"""

from service.tool_settings import sub_settings  # noqa: F401  (auto-registers schemas)
from service.tool_settings.base import (
    RESERVED_EXTRAS_KEYS,
    ToolSettingSchema,
    get_tool_setting_registry,
    get_tool_setting_schemas,
    register_tool_setting,
    sanitize_tool_settings,
)

__all__ = [
    "RESERVED_EXTRAS_KEYS",
    "ToolSettingSchema",
    "get_tool_setting_registry",
    "get_tool_setting_schemas",
    "register_tool_setting",
    "sanitize_tool_settings",
]
