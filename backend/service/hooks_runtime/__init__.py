"""Hooks runtime — user-facing automation ("Hooks").

A Hook is an agent-created automation bound to the chat session that created
it. It runs autonomously in the background (on a schedule, or polling on an
interval for an event condition) and posts its result back into that session's
chat. Hooks are stored as ``CronJob`` rows with ``target_kind="agent_hook"``
(reusing the executor cron scheduler as the engine) and fired by
:class:`AgentHookExecutor`.

This package owns the pieces that are Geny-specific (session binding + chat
delivery); the scheduling engine itself stays in geny-executor's cron module,
reused unchanged.
"""

from service.hooks_runtime.delivery import post_autonomous_message

__all__ = ["post_autonomous_message"]
