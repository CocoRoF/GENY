"""Geny → GAPT integration.

Geny delegates all project / workspace / sandbox / deploy work to GAPT (the
vendored ``gapt/`` sub-repo) — see ``docs/analysis/gapt-integration-plan.md``.

- :class:`GaptClient` — thin async HTTP client for GAPT's ``/_gapt/api/**``
  (single-admin cookie auth).
- :class:`GaptWorkspaceProvider` / :class:`GaptSandboxHandle` — provision a GAPT
  workspace for a Geny session and hand the executor a ``SandboxHandle`` so the
  agent CLI runs inside the workspace container (``ContainerCLIRunner``).
"""

from service.gapt.client import GaptApiError, GaptClient, get_gapt_client
from service.gapt.provider import GaptSandboxHandle, GaptWorkspaceProvider

__all__ = [
    "GaptClient",
    "GaptApiError",
    "get_gapt_client",
    "GaptSandboxHandle",
    "GaptWorkspaceProvider",
]
