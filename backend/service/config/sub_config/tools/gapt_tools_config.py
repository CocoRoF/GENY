"""GAPT Tools — per-tool enable/disable for the gapt_* control-plane tools.

The 9 ``gapt_*`` tools (defined in ``tools/built_in/gapt_tools.py``) are gated by
config tokens: each tool declares ``REQUIRED_CONFIG = ("config:gapt",
"gapt_tool:<name>")``. ``config:gapt`` is emitted when GAPT is configured; the
``gapt_tool:<name>`` tokens are emitted (per ``compute_satisfied_config``) only
for the tools enabled HERE. A user who never touches this config gets every
``gapt_tool:*`` token (all fields default to ``True``), so the gating is a no-op
until they explicitly turn a tool OFF.

Boolean field per tool (not a multiselect) because the generic Settings auto-form
renders booleans/selects but has no multiselect renderer — booleans give a clean
toggle list. User-visible in the Tool category; only meaningful when GAPT is
configured.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config


@register_config
@dataclass
class GaptToolsConfig(BaseConfig):
    """Which gapt_* tools are exposed to agents. Default: all enabled."""

    gapt_overview: bool = True
    gapt_list_projects: bool = True
    gapt_create_project: bool = True
    gapt_list_workspaces: bool = True
    gapt_create_workspace: bool = True
    gapt_manage_workspace: bool = True
    gapt_run_command: bool = True
    gapt_list_environments: bool = True
    gapt_deploy: bool = True

    @classmethod
    def get_config_name(cls) -> str:
        return "gapt_tools"

    @classmethod
    def get_display_name(cls) -> str:
        return "GAPT Tools"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Enable/disable individual GAPT control-plane tools (projects, "
            "workspaces, deploys). All on by default — turn off the ones agents "
            "shouldn't use. Only takes effect when GAPT is configured."
        )

    @classmethod
    def get_category(cls) -> str:
        return "tools"

    @classmethod
    def get_icon(cls) -> str:
        return "wrench"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "GAPT 도구",
                "description": (
                    "GAPT 컨트롤 플레인 도구(프로젝트/워크스페이스/배포)를 개별로 "
                    "켜고 끕니다. 기본은 전부 켜짐 — 에이전트가 쓰지 않을 도구만 "
                    "끄세요. GAPT가 설정된 경우에만 적용됩니다."
                ),
                "fields": {
                    "gapt_overview": {"label": "개요 (gapt_overview)"},
                    "gapt_list_projects": {"label": "프로젝트 목록 (gapt_list_projects)"},
                    "gapt_create_project": {"label": "프로젝트 생성 (gapt_create_project)"},
                    "gapt_list_workspaces": {"label": "워크스페이스 목록 (gapt_list_workspaces)"},
                    "gapt_create_workspace": {"label": "워크스페이스 생성 (gapt_create_workspace)"},
                    "gapt_manage_workspace": {"label": "워크스페이스 관리 (gapt_manage_workspace)"},
                    "gapt_run_command": {"label": "명령 실행 (gapt_run_command)"},
                    "gapt_list_environments": {"label": "배포 환경 목록 (gapt_list_environments)"},
                    "gapt_deploy": {"label": "배포 (gapt_deploy)"},
                },
            }
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(name="gapt_overview", field_type=FieldType.BOOLEAN,
                        label="Overview (gapt_overview)",
                        description="Platform snapshot: all projects + workspace stats.",
                        default=True, group="tools"),
            ConfigField(name="gapt_list_projects", field_type=FieldType.BOOLEAN,
                        label="List Projects (gapt_list_projects)",
                        description="List all GAPT projects.",
                        default=True, group="tools"),
            ConfigField(name="gapt_create_project", field_type=FieldType.BOOLEAN,
                        label="Create Project (gapt_create_project)",
                        description="Create a GAPT project.",
                        default=True, group="tools"),
            ConfigField(name="gapt_list_workspaces", field_type=FieldType.BOOLEAN,
                        label="List Workspaces (gapt_list_workspaces)",
                        description="List a project's workspaces.",
                        default=True, group="tools"),
            ConfigField(name="gapt_create_workspace", field_type=FieldType.BOOLEAN,
                        label="Create Workspace (gapt_create_workspace)",
                        description="Create a sandbox workspace in a project.",
                        default=True, group="tools"),
            ConfigField(name="gapt_manage_workspace", field_type=FieldType.BOOLEAN,
                        label="Manage Workspace (gapt_manage_workspace)",
                        description="Start / stop / delete a workspace.",
                        default=True, group="tools"),
            ConfigField(name="gapt_run_command", field_type=FieldType.BOOLEAN,
                        label="Run Command (gapt_run_command)",
                        description="Run a shell command inside a workspace container.",
                        default=True, group="tools"),
            ConfigField(name="gapt_list_environments", field_type=FieldType.BOOLEAN,
                        label="List Environments (gapt_list_environments)",
                        description="List a project's deploy environments.",
                        default=True, group="tools"),
            ConfigField(name="gapt_deploy", field_type=FieldType.BOOLEAN,
                        label="Deploy (gapt_deploy)",
                        description="Kick off an async deploy of an environment.",
                        default=True, group="tools"),
        ]
