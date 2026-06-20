"""Tool-setting schemas — importing a module here registers its schema.

Add a new tool's settings by creating a module that declares a
``@register_tool_setting`` :class:`~service.tool_settings.base.ToolSettingSchema`
and importing it below.
"""

from service.tool_settings.sub_settings import web_search  # noqa: F401  (registers)

__all__ = ["web_search"]
