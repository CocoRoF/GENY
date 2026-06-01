"""
Tool Preset Templates — default preset mapping by role.

Only the "All Tools" template is auto-installed on startup. The VTuber-
specific preset was removed in PR #1 (Phase A2) — it was a stale
duplicate of the env-manifest whitelist and was not actually used as a
runtime filter (see comment in ``agent_session_manager.py`` § preset
resolution: "no longer fed into pipeline construction — log only").
The env manifest's ``tools.external`` is now the single source of truth
for which custom tools a VTuber session sees.
"""

from __future__ import annotations

from service.tool_preset.models import ToolPresetDefinition
from service.tool_preset.store import ToolPresetStore


def create_all_tools_preset() -> ToolPresetDefinition:
    """Everything enabled."""
    return ToolPresetDefinition(
        id="template-all-tools",
        name="All Tools",
        description="Activate all custom tools and MCP servers.",
        icon="🚀",
        custom_tools=["*"],
        mcp_servers=["*"],
        is_template=True,
        template_name="all-tools",
    )


_TEMPLATE_FACTORIES = [
    create_all_tools_preset,
]

# Templates that used to exist and should be actively removed on boot.
# ``ToolPresetStore`` keeps orphans by design, so retiring a template
# means listing it here so old DB rows / on-disk JSON files get cleaned
# up next time the app starts.
_RETIRED_TEMPLATE_IDS: tuple[str, ...] = (
    "template-vtuber-tools",  # PR #1 (Phase A2) — replaced by env manifest
)


def install_templates(store: ToolPresetStore) -> int:
    """Install default template presets and prune retired ones.

    Returns the number of *new* templates seeded. Retired-template
    deletions happen silently — they're an idempotent cleanup, not a
    user-visible operation.
    """
    # Retire deprecated templates first so a same-boot reinstall of a
    # retired+renamed template is well-defined (insert wins).
    for old_id in _RETIRED_TEMPLATE_IDS:
        try:
            store.delete(old_id)
        except Exception:
            # store.delete is best-effort; failures here must not block boot.
            pass

    installed = 0
    for factory in _TEMPLATE_FACTORIES:
        preset = factory()
        if not store.exists(preset.id):
            store.save(preset)
            installed += 1
    return installed


# ── Default preset mapping by role ──
#
# Every role maps to the unrestricted "all-tools" preset. The env
# manifest decides what each role actually receives via the
# ``tools.external`` list (see ``service/environment/templates.py``).

ROLE_DEFAULT_PRESET: dict[str, str] = {
    "worker": "template-all-tools",
    "developer": "template-all-tools",
    "researcher": "template-all-tools",
    "planner": "template-all-tools",
    "vtuber": "template-all-tools",
}
