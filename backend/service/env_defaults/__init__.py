"""
env_defaults — host-level "default for new environments" service.

Hooks, skills, permission rules, and custom MCP servers all live in
their own host registries. Each entry can be marked as a *default*
for newly-created environments — when a user clicks "새 드래프트" in
the env management UI, the freshly-seeded manifest pre-checks every
default item via `manifest.host_selections.{category}`.

Storage uses Geny's existing `persistent_configs` table (DB-primary,
JSON fallback). Each category gets one row:

    config_name = "env_defaults"
    config_key  = "hooks" | "skills" | "permissions" | "mcp_servers"
    config_value = JSON-serialised list of stable item ids
    data_type   = "list"
    category    = "env_management"

A missing row OR an empty list is interpreted as **uncurated** by
the frontend seeder — i.e. fall back to the wildcard sentinel
`["*"]` so the new env gets every host registration. An explicit
list narrows the default set to exactly those items.

The id format is intentionally a string per category:

    hooks        — "<event>::<command joined by space>"
    skills       — skill id (the SKILL.md frontmatter id)
    permissions  — "<tool_name>::<pattern>::<behavior>" (index-free
                   so re-ordering rules in settings.json doesn't
                   break the default set)
    mcp_servers  — server name

The service does not validate that the ids exist in the host
registry — manifests outlive registry edits, so a stale id is
silently ignored at seed time. The frontend picker's empty-state
ribbon is the surfacing channel.
"""

from service.env_defaults.service import (
    EnvDefaultsService,
    SUPPORTED_CATEGORIES,
)

__all__ = ["EnvDefaultsService", "SUPPORTED_CATEGORIES"]
