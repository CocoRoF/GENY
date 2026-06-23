"""Turn a saved Sandbox Tool Pack into live, session-ready tools + skills.

A pack is one capability: an independent GAPT environment (workspace restorable
from a snapshot) + N tools whose code runs *inside* it + M skills documenting
them. Loading a pack yields:

  * a list of executor :class:`SandboxExecTool` instances, all sharing one
    :class:`PackSandboxHandle` (they run in the pack's own workspace), and
  * a list of executor :class:`Skill` objects (the usage guidance).

``PackSandboxHandle.ensure()`` makes the snapshot the *durable truth*: it boots
the pack's persistent workspace, and if that workspace is gone (a cold host)
re-provisions it in the pack's GAPT project and restores it from the snapshot —
so the tool always runs in the exact environment it was saved with.
"""

from __future__ import annotations

import logging
from typing import Any, List, Tuple

from service.gapt.client import GaptApiError
from service.sandbox_tool_packs.models import (
    PackSkill,
    SandboxToolPackDefinition,
)

logger = logging.getLogger(__name__)


class PackSandboxHandle:
    """A SandboxHandle (``container_name`` + async ``ensure()``) for a pack's
    dedicated GAPT workspace, with cold-restore-from-snapshot."""

    def __init__(
        self,
        gapt_client: Any,
        *,
        project_ref: str,
        workspace_ref: str,
        snapshot_ref: str = "",
        workspace_name: str = "",
    ) -> None:
        self._client = gapt_client
        self._project_ref = project_ref
        self._workspace_ref = workspace_ref
        self._snapshot_ref = snapshot_ref
        self._workspace_name = workspace_name or f"pack-{workspace_ref}"
        self._ready = False

    @property
    def container_name(self) -> str:
        return f"gapt-ws-{self._workspace_ref.lower()}"

    @property
    def workspace_ref(self) -> str:
        return self._workspace_ref

    async def ensure(self) -> None:
        if self._ready:
            return
        try:
            # Boot the pack's persistent workspace (idempotent docker run).
            await self._client.run_command(self._workspace_ref, "true")
        except GaptApiError as exc:
            # Cold / lost workspace → re-provision from the snapshot (the
            # durable truth) so the tool runs in its exact saved environment.
            if exc.status == 404 and self._snapshot_ref and self._project_ref:
                logger.info(
                    "pack workspace %s missing — re-provisioning from snapshot %s",
                    self._workspace_ref, self._snapshot_ref,
                )
                ws = await self._client.create_workspace(
                    self._project_ref, name=self._workspace_name
                )
                self._workspace_ref = (ws or {}).get("id") or self._workspace_ref
                await self._client.run_command(self._workspace_ref, "true")
                await self._client.restore_snapshot(
                    self._snapshot_ref, target_workspace_id=self._workspace_ref
                )
            else:
                raise
        self._ready = True


def _build_skill(ps: PackSkill) -> Any:
    from geny_executor.skills.types import Skill, SkillMetadata  # noqa: PLC0415

    meta = SkillMetadata(
        name=ps.id,
        description=ps.description or ps.id,
        allowed_tools=tuple(ps.allowed_tools or ()),
        execution_mode="inline",
    )
    return Skill(id=ps.id, metadata=meta, body=ps.body or "", source=None)


def load_pack(
    pack: SandboxToolPackDefinition, *, gapt_client: Any
) -> Tuple[List[Any], List[Any]]:
    """Build (``[SandboxExecTool]``, ``[Skill]``) for *pack*.

    All of the pack's tools share one :class:`PackSandboxHandle` (they run in
    the same workspace). Skills become executor ``Skill`` objects.
    """
    from geny_executor.tools.built_in.sandbox_exec_tool import (  # noqa: PLC0415
        SandboxExecTool,
    )

    handle = PackSandboxHandle(
        gapt_client,
        project_ref=pack.project_ref,
        workspace_ref=pack.workspace_ref,
        snapshot_ref=pack.snapshot_ref,
        workspace_name=f"pack-{pack.name}",
    )
    tools = [
        SandboxExecTool.from_dict(spec.model_dump(), sandbox=handle)
        for spec in pack.tools
    ]
    skills = [_build_skill(ps) for ps in pack.skills]
    return tools, skills


class SandboxToolPackProvider:
    """Adhoc, get-style provider surfacing every ENABLED pack's tools (and
    exposing their skills). Built from the store; pass it to a session the same
    way as ``GenyToolProvider``. Skills are read via :meth:`skills` and merged
    into the session's SkillRegistry by the caller.
    """

    def __init__(self, *, store: Any, gapt_client: Any) -> None:
        self._tools: dict[str, Any] = {}
        self._skills: List[Any] = []
        self._pack_of: dict[str, str] = {}  # tool name → pack name (diagnostics)
        for pack in store.list_enabled():
            try:
                tools, skills = load_pack(pack, gapt_client=gapt_client)
            except Exception:  # noqa: BLE001 — one broken pack never sinks the rest
                logger.warning("pack %s failed to load — skipping", pack.name, exc_info=True)
                continue
            for t in tools:
                if t.name in self._tools:
                    logger.warning(
                        "pack tool name collision %r (packs %s + %s) — first wins",
                        t.name, self._pack_of.get(t.name), pack.name,
                    )
                    continue
                self._tools[t.name] = t
                self._pack_of[t.name] = pack.name
            self._skills.extend(skills)

    def list_names(self) -> List[str]:
        return list(self._tools.keys())

    def get(self, name: str) -> Any:
        return self._tools.get(name)

    def skills(self) -> List[Any]:
        return list(self._skills)
