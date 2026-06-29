"""Hook tools — user-facing automations (HookCreate / HookList / HookDelete / HookToggle).

A **Hook** runs an action prompt autonomously in the chat session that created
it — on a schedule (cron time) or as an event poll (interval + condition) — and
delivers the result back into that chat. Hooks are stored as cron jobs with
``target_kind="agent_hook"`` (reusing the executor cron scheduler) and fired by
Geny's ``AgentHookExecutor``, which runs the prompt as a trigger turn in the
owning session and posts the result via the shared autonomous-delivery path.

These are thin facades over the cron store injected at
``ToolContext.extras["cron_store"]`` (same wiring the executor's CronCreate uses)
that auto-bind the caller's ``session_id`` and the ``agent_hook`` convention.
Auto-loaded by ToolLoader (``*_tools.py`` + module-level ``TOOLS``).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from geny_executor.cron.types import CronJob, CronJobStatus
from geny_executor.tools.base import Tool, ToolCapabilities, ToolContext, ToolResult

_TARGET_KIND = "agent_hook"
_NAME_PREFIX = "hook__"


def _err(code: str, message: str) -> ToolResult:
    return ToolResult(content={"error": {"code": code, "message": message}}, is_error=True)


async def _refresh(context: ToolContext) -> None:
    runner = context.extras.get("cron_runner") if context and context.extras else None
    refresh = getattr(runner, "refresh", None) if runner else None
    if callable(refresh):
        result = refresh()
        if hasattr(result, "__await__"):
            await result


def _validate_cron(expr: str) -> str | None:
    try:
        from croniter import croniter, CroniterBadCronError  # type: ignore[import-not-found]
    except ImportError:
        return None
    try:
        croniter(expr)
    except (CroniterBadCronError, KeyError, ValueError, TypeError) as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        return str(exc)
    return None


def _slug(text: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return (s or "hook")[:32]


def _hook_name(session_id: str, label: str) -> str:
    return f"{_NAME_PREFIX}{(session_id or 'sess')[:8]}__{_slug(label)}"


def _is_hook(job: CronJob) -> bool:
    return getattr(job, "target_kind", None) == _TARGET_KIND


def _owned(job: CronJob, session_id: str) -> bool:
    return (getattr(job, "payload", None) or {}).get("session_id") == session_id


def _store(context: ToolContext):
    return context.extras.get("cron_store") if context and context.extras else None


def _session_id(context: ToolContext):
    return getattr(context, "session_id", None) if context else None


class HookCreateTool(Tool):
    @property
    def name(self) -> str:
        return "HookCreate"

    @property
    def description(self) -> str:
        return (
            "Create a persistent background automation ('Hook') bound to THIS chat. It runs "
            "autonomously and posts results back into this conversation. Two kinds:\n"
            "- kind='schedule': runs at a fixed time. e.g. every morning 9am -> cron_expr '0 9 * * *'.\n"
            "- kind='event': polls on an interval and notifies ONLY when a condition is met. "
            "e.g. check Gmail every 10 minutes -> cron_expr '*/10 * * * *'. The runtime appends a "
            "note instructing the action to report only what is NEW since the last check and to "
            "reply [SILENT] when there is nothing to report (so the user is not spammed).\n"
            "action_prompt is the instruction executed each fire; it can use this session's tools "
            "(e.g. Gmail). cron_expr is a standard 5-field expression (minute hour day month weekday); "
            "minimum granularity is 1 minute. Use HookList/HookDelete/HookToggle to manage them."
        )

    @property
    def input_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string", "maxLength": 64, "description": "Short label for the hook."},
                "kind": {"type": "string", "enum": ["schedule", "event"]},
                "cron_expr": {"type": "string", "description": "5-field cron expression."},
                "action_prompt": {"type": "string", "description": "What to do each fire."},
                "description": {"type": "string"},
            },
            "required": ["kind", "cron_expr", "action_prompt"],
        }

    def capabilities(self, input: Dict[str, Any]) -> ToolCapabilities:
        return ToolCapabilities(concurrency_safe=False)

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        store = _store(context)
        if store is None:
            return _err("NO_STORE", "cron_store not wired into ctx.extras")
        session_id = _session_id(context)
        if not session_id:
            return _err("NO_SESSION", "HookCreate must run inside a chat session")
        kind = (input.get("kind") or "schedule").lower()
        if kind not in ("schedule", "event"):
            return _err("BAD_KIND", "kind must be 'schedule' or 'event'")
        expr = input["cron_expr"]
        verr = _validate_cron(expr)
        if verr is not None:
            return _err("INVALID_CRON_EXPR", verr)

        label = input.get("name") or input["action_prompt"]
        name = _hook_name(session_id, label)
        if await store.get(name) is not None:
            i = 2
            while await store.get(f"{name}-{i}") is not None:
                i += 1
            name = f"{name}-{i}"

        job = CronJob(
            name=name,
            cron_expr=expr,
            target_kind=_TARGET_KIND,
            payload={
                "session_id": session_id,
                "kind": kind,
                "action_prompt": input["action_prompt"],
            },
            description=input.get("description"),
        )
        await store.put(job)
        await _refresh(context)
        return ToolResult(
            content={"name": name, "kind": kind, "cron_expr": expr, "status": job.status.value}
        )


class HookListTool(Tool):
    @property
    def name(self) -> str:
        return "HookList"

    @property
    def description(self) -> str:
        return "List the Hooks (background automations) created in THIS chat session."

    @property
    def input_schema(self) -> Dict[str, Any]:
        return {"type": "object", "properties": {}}

    def capabilities(self, input: Dict[str, Any]) -> ToolCapabilities:
        return ToolCapabilities(concurrency_safe=True, read_only=True, idempotent=True)

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        store = _store(context)
        if store is None:
            return _err("NO_STORE", "cron_store not wired into ctx.extras")
        session_id = _session_id(context)
        jobs = await store.list(only_enabled=False)
        hooks: List[Dict[str, Any]] = []
        for j in jobs:
            if not (_is_hook(j) and _owned(j, session_id)):
                continue
            payload = getattr(j, "payload", None) or {}
            hooks.append(
                {
                    "name": j.name,
                    "kind": payload.get("kind", "schedule"),
                    "cron_expr": j.cron_expr,
                    "status": j.status.value if hasattr(j.status, "value") else str(j.status),
                    "description": j.description,
                    "action_prompt": payload.get("action_prompt"),
                    "last_fired_at": j.last_fired_at.isoformat() if j.last_fired_at else None,
                }
            )
        return ToolResult(content={"hooks": hooks})


class HookDeleteTool(Tool):
    @property
    def name(self) -> str:
        return "HookDelete"

    @property
    def description(self) -> str:
        return "Delete a Hook by name (from HookList). Only hooks created in this session can be deleted."

    @property
    def input_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        }

    def capabilities(self, input: Dict[str, Any]) -> ToolCapabilities:
        return ToolCapabilities(concurrency_safe=False, destructive=True)

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        store = _store(context)
        if store is None:
            return _err("NO_STORE", "cron_store not wired into ctx.extras")
        session_id = _session_id(context)
        name = input["name"]
        job = await store.get(name)
        if job is None or not (_is_hook(job) and _owned(job, session_id)):
            return _err("NOT_FOUND", f"no hook {name!r} in this session")
        ok = await store.delete(name)
        await _refresh(context)
        return ToolResult(content={"name": name, "deleted": bool(ok)})


class HookToggleTool(Tool):
    @property
    def name(self) -> str:
        return "HookToggle"

    @property
    def description(self) -> str:
        return "Enable or disable a Hook by name (pause/resume without deleting it)."

    @property
    def input_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {"name": {"type": "string"}, "enabled": {"type": "boolean"}},
            "required": ["name", "enabled"],
        }

    def capabilities(self, input: Dict[str, Any]) -> ToolCapabilities:
        return ToolCapabilities(concurrency_safe=False)

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        store = _store(context)
        if store is None:
            return _err("NO_STORE", "cron_store not wired into ctx.extras")
        session_id = _session_id(context)
        name = input["name"]
        job = await store.get(name)
        if job is None or not (_is_hook(job) and _owned(job, session_id)):
            return _err("NOT_FOUND", f"no hook {name!r} in this session")
        status = CronJobStatus.ENABLED if input.get("enabled") else CronJobStatus.DISABLED
        await store.update_status(name, status)
        await _refresh(context)
        return ToolResult(content={"name": name, "status": status.value})


TOOLS = [HookCreateTool(), HookListTool(), HookDeleteTool(), HookToggleTool()]

__all__ = ["TOOLS"]
