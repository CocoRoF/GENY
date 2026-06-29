"""AgentHookExecutor — runs a Hook fire as an agent turn in the owning session.

Registered as the ``agent_hook`` :class:`BackgroundTaskExecutor` kind on the
shared :class:`BackgroundTaskRunner` (next to ``local_bash`` / ``local_agent``).
The executor cron daemon fires a Hook by submitting a ``TaskRecord`` of this
kind; we then:

1. Resolve a dedup watermark (``last_seen``) from the hook's cron payload.
2. Run the hook's ``action_prompt`` as a trigger turn in the OWNING session
   (``execute_command(session_id, ..., is_trigger=True)``) — so the run inherits
   that session's credentials + tools (Gmail, etc.) via lazy session restore.
3. Deliver the result into the session's chat (silent on ``[SILENT]``).
4. Advance the ``last_seen`` watermark on success so the next poll only
   considers what is new.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

from geny_executor.runtime import BackgroundTaskExecutor
from geny_executor.stages.s13_task_registry.types import TaskRecord

logger = logging.getLogger(__name__)


class AgentHookExecutor(BackgroundTaskExecutor):
    """Executes ``target_kind="agent_hook"`` tasks (Hook fires).

    Required ``record.payload`` keys:
        ``session_id``    — the chat session that owns the hook (delivery target)
        ``action_prompt`` — the instruction to run each fire

    Optional:
        ``kind``       — "schedule" | "event" (event appends a dedup + silence note)
        ``last_seen``  — dedup watermark (managed here)
        ``timeout_s``  — per-fire wall-clock budget for the agent turn
    """

    def __init__(self, app_state: Any, *, default_timeout_s: Optional[float] = None) -> None:
        self._app_state = app_state
        self._default_timeout_s = default_timeout_s

    @staticmethod
    def _build_prompt(payload: dict, since: str) -> str:
        base = payload.get("action_prompt") or payload.get("prompt") or ""
        kind = (payload.get("kind") or "schedule").lower()
        if kind == "event":
            return (
                f"{base}\n\n[hook] Automated check — only report what is NEW since "
                f"{since} (UTC). If there is nothing new to report, reply with EXACTLY "
                f"[SILENT] and nothing else."
            )
        return base

    async def execute(self, record: TaskRecord) -> AsyncIterator[bytes]:
        payload = dict(record.payload or {})
        session_id = payload.get("session_id")
        if not session_id:
            raise ValueError("agent_hook task requires payload['session_id']")
        action_prompt = payload.get("action_prompt") or payload.get("prompt")
        if not action_prompt:
            raise ValueError("agent_hook task requires payload['action_prompt']")

        cron_name = payload.get("_cron_name")
        store = getattr(self._app_state, "cron_store", None)

        # Resolve dedup watermark from the live cron payload (the runner stamps
        # last_fired_at=now BEFORE we run, so we keep our own ``last_seen``).
        since = payload.get("last_seen")
        job = None
        if store is not None and cron_name:
            try:
                job = await store.get(cron_name)
                if job is not None:
                    since = (job.payload or {}).get("last_seen") or since
            except Exception:  # noqa: BLE001
                job = None
        since = since or payload.get("_scheduled_for") or "the hook was created"
        run_start = datetime.now(timezone.utc).isoformat()

        prompt = self._build_prompt(payload, since)

        from service.execution.agent_executor import execute_command

        result = await execute_command(
            session_id,
            prompt,
            is_trigger=True,
            timeout=payload.get("timeout_s") or self._default_timeout_s,
        )
        if not getattr(result, "success", False):
            # Surface to the runner (task → FAILED); don't advance the watermark
            # so the next poll re-checks the same window.
            raise RuntimeError(getattr(result, "error", None) or "hook agent run failed")

        from service.hooks_runtime.delivery import post_autonomous_message

        room_id = post_autonomous_message(session_id, result, source="hook")

        # Advance the watermark only on a successful run.
        if store is not None and job is not None:
            try:
                job.payload = {**(job.payload or {}), "last_seen": run_start}
                await store.put(job)
            except Exception:  # noqa: BLE001
                logger.warning("[agent_hook] watermark update failed for %s", cron_name, exc_info=True)

        status = "delivered" if room_id else "silent"
        yield json.dumps(
            {"status": status, "room_id": room_id, "since": since, "session_id": session_id},
            ensure_ascii=False,
            default=str,
        ).encode("utf-8")


__all__ = ["AgentHookExecutor"]
