"""Sandbox Tool Pack tools — let an agent DISCOVER and LOAD reusable tool packs
it (or others) built in a sandbox, completing the self-service lifecycle:

    [create]  env(action="forge_tool")      — build a tool in your workspace
    [save]    env(action="save_pack")        — snapshot it as a reusable pack
    [list]    list_tool_packs                — browse saved packs   ← here
    [use]     use_tool_pack(pack_id)         — load a pack's tools now  ← here

``list_tool_packs`` reads the persisted pack registry; ``use_tool_pack`` restores
a pack's snapshotted workspace and registers its tools (+ skills) into THIS
session so they're callable from the next turn — the tools run inside the pack's
own sandbox (docker exec). Auto-loads when GAPT is configured (matches the
``*_tools.py`` pattern). Available in every env that carries the platform tools.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Optional

from geny_executor.tools.base import ToolCapabilities, ToolContext, ToolResult

from service.gapt.client import get_gapt_client
from tools.base import BaseTool

_MAX = 16_000


def _ok(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)[:_MAX]


def _err(msg: str, **extra: Any) -> str:
    return json.dumps({"error": msg, **extra}, ensure_ascii=False)


class ListToolPacksTool(BaseTool):
    """Browse saved Sandbox Tool Packs."""

    name = "list_tool_packs"
    description = (
        "List saved Sandbox Tool Packs — reusable [sandbox workspace + tools + "
        "skills] you or others built. Returns each pack's id, name, description, "
        "tool/skill counts and whether it's enabled. Use this to discover tools "
        "you can load into this session with use_tool_pack."
    )
    parameters: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "enabled_only": {
                "type": "boolean",
                "description": "Only list owner-enabled packs (default false = all).",
            }
        },
        "required": [],
        "additionalProperties": False,
    }
    CAPABILITIES = ToolCapabilities(max_result_chars=_MAX)

    async def arun(self, enabled_only: bool = False, **_: Any) -> str:
        from service.sandbox_tool_packs import get_sandbox_tool_pack_store

        store = get_sandbox_tool_pack_store()
        try:
            packs = store.list_enabled() if enabled_only else store.list_all()
        except Exception as e:  # noqa: BLE001
            return _err(f"could not list packs: {e}")
        return _ok(
            {
                "packs": [
                    {
                        "id": p.id,
                        "name": p.name,
                        "description": p.description,
                        "tools": [t.name for t in p.tools],
                        "skills": [s.id for s in p.skills],
                        "enabled": p.enabled,
                    }
                    for p in packs
                ]
            }
        )

    def run(self, **kwargs: Any) -> str:
        return asyncio.run(self.arun(**kwargs))


class UseToolPackTool(BaseTool):
    """Load a saved pack's tools + skills into THIS session."""

    name = "use_tool_pack"
    description = (
        "Load a saved Sandbox Tool Pack into THIS session so its tools become "
        "callable (from the next turn). Pass pack_id (from list_tool_packs). The "
        "pack's workspace is restored from its snapshot and its tools run inside "
        "that sandbox; its skills are surfaced too."
    )
    parameters: Dict[str, Any] = {
        "type": "object",
        "properties": {
            "pack_id": {"type": "string", "description": "Pack id from list_tool_packs."},
        },
        "required": ["pack_id"],
        "additionalProperties": False,
    }
    CAPABILITIES = ToolCapabilities(max_result_chars=_MAX, concurrency_safe=False)

    async def execute(
        self, input: Dict[str, Any], context: Optional[ToolContext] = None
    ) -> ToolResult:
        pack_id = str((input or {}).get("pack_id") or "").strip()
        if not pack_id:
            return ToolResult(content=_err("pack_id is required"), is_error=True)
        env = getattr(context, "environment", None) if context else None
        if env is None:
            return ToolResult(
                content=_err("no session environment to load the pack into"),
                is_error=True,
            )
        gc = get_gapt_client()
        if not gc.configured:
            return ToolResult(content=_err("GAPT is not configured"), is_error=True)
        from service.sandbox_tool_packs import get_sandbox_tool_pack_store, load_pack
        from service.sandbox_tool_packs.store import SandboxToolPackNotFound

        store = get_sandbox_tool_pack_store()
        try:
            pack = store.get(pack_id)
        except SandboxToolPackNotFound:
            return ToolResult(content=_err(f"pack not found: {pack_id}"), is_error=True)
        try:
            tools, skills = load_pack(pack, gapt_client=gc)
        except Exception as e:  # noqa: BLE001
            return ToolResult(content=_err(f"could not load pack: {e}"), is_error=True)

        registry = getattr(env, "_registry", None)
        skill_registry = getattr(env, "_skill_registry", None)
        loaded_tools, loaded_skills = [], []
        for t in tools:
            if registry is not None and registry.get(t.name) is None:
                registry.register(t)
                loaded_tools.append(t.name)
        for s in skills:
            if skill_registry is not None and skill_registry.get(s.id) is None:
                try:
                    skill_registry.register(s)
                    loaded_skills.append(s.id)
                except Exception:  # noqa: BLE001
                    pass
        return ToolResult(
            content=_ok(
                {
                    "loaded_pack": pack.name,
                    "tools_now_callable_next_turn": loaded_tools or [t.name for t in tools],
                    "skills": loaded_skills,
                }
            )
        )

    async def arun(self, pack_id: str = "", **_: Any) -> str:
        # Fallback when dispatched without a context (no session to load into).
        res = await self.execute({"pack_id": pack_id}, None)
        return res.content if isinstance(res.content, str) else _ok(res.content)

    def run(self, **kwargs: Any) -> str:
        return asyncio.run(self.arun(**kwargs))


TOOLS = [ListToolPacksTool(), UseToolPackTool()] if get_gapt_client().configured else []
