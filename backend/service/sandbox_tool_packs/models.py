"""Sandbox Tool Pack definitions.

A **pack** is one installable capability an agent built in a sandbox:

    [ independent GAPT environment (project + workspace + snapshot) ]
  + [ 1..N tools whose code runs INSIDE that sandbox (SandboxExecTool specs) ]
  + [ 0..M skills documenting how to use those tools ]

The pack is the persistent, reproducible unit. ``SandboxToolSpec`` is the exact
serialized form of the executor's ``SandboxExecTool`` (the capability lives in
geny-executor, not a Geny adapter layer — "extend executor, not adapter"). The
snapshot is the durable truth for the environment: a cold reuse restores the
workspace from ``snapshot_ref``.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SandboxToolSpec(BaseModel):
    """One tool in the pack — verbatim ``SandboxExecTool.to_dict()`` shape."""

    name: str
    description: str = ""
    input_schema: Dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    runtime: str = "python3"
    entrypoint: str
    argv: List[str] = Field(default_factory=list)
    timeout_s: float = 60.0
    workdir: str = "/workspace"
    network_egress: bool = False
    read_only: bool = False


class PackSkill(BaseModel):
    """A skill bundled with the pack — usage guidance for its tools, surfaced
    through the executor's progressive-disclosure skills system."""

    id: str
    description: str = ""
    body: str = ""
    allowed_tools: List[str] = Field(default_factory=list)


class SandboxToolPackDefinition(BaseModel):
    """The full, persisted pack payload (stored as JSONB in ``data``)."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    name: str
    description: str = ""

    # The pack's dedicated, isolated GAPT environment (decision G — project
    # separation) + the snapshot its workspace is reproduced from when cold.
    project_ref: str = ""
    workspace_ref: str = ""
    snapshot_ref: str = ""

    tools: List[SandboxToolSpec] = Field(default_factory=list)
    skills: List[PackSkill] = Field(default_factory=list)

    # Code → default OFF until the owner confirms (security).
    enabled: bool = False
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
