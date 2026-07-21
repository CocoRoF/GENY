"""Geny → GAPT integration.

Geny delegates all project / workspace / sandbox / deploy work to GAPT (the
vendored ``gapt/`` sub-repo) — see ``docs/analysis/gapt-integration-plan.md``.

- :class:`GaptClient` — thin async HTTP client for GAPT's ``/_gapt/api/**``
  (single-admin cookie auth).
- :class:`GaptWorkspaceProvider` / :class:`GaptSandboxHandle` — provision a GAPT
  workspace for a Geny session and hand the executor a ``SandboxHandle`` so the
  agent CLI runs inside the workspace container (``ContainerCLIRunner``).
"""

import logging
import os

from service.gapt.client import GaptApiError, GaptClient, get_gapt_client
from service.gapt.provider import GaptSandboxHandle, GaptWorkspaceProvider

_logger = logging.getLogger(__name__)


async def delete_workspace_for_session(session_id: str) -> bool:
    """Delete the GAPT workspace bound to ``session_id`` (best-effort, idempotent).

    A session's GAPT workspace is named after the session id. This finds it in
    the Geny project and deletes it; a no-op if GAPT is unconfigured or the
    workspace is already gone. Called both when a live session is torn down and
    on permanent delete of a dormant one, so the agent's workspace never
    outlives the agent. Never raises.
    """
    try:
        gc = get_gapt_client()
        if not gc.configured:
            return False
        prov = GaptWorkspaceProvider(gc)
        proj = await prov._find_project_by_slug(os.getenv("GENY_GAPT_PROJECT_SLUG", "geny"))
        if not proj:
            return False
        ws = await prov._find_workspace_by_name(proj.get("id") or "", session_id)
        if ws and ws.get("id"):
            await gc.delete_workspace(ws["id"])
            _logger.info("[%s] gapt workspace deleted", session_id)
            return True
    except Exception:  # noqa: BLE001 — workspace cleanup must never block delete
        _logger.debug("[%s] gapt workspace delete failed", session_id, exc_info=True)
    return False


__all__ = [
    "GaptClient",
    "GaptApiError",
    "get_gapt_client",
    "GaptSandboxHandle",
    "GaptWorkspaceProvider",
    "delete_workspace_for_session",
]
