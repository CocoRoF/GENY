"""SubagentType registry viewer (PR-F.3.1).

Exposes the list of agent_type descriptors that Geny seeds into the
executor's Stage 12 subagent registry. Used by the AdminPanel
"Subagent Types" panel (PR-F.3.4) and the TasksTab "New Task" modal
(PR-F.3.2).

Read-only — descriptors live in code today (service.agent_types.registry).
A future PR can add CRUD if the executor exposes a writable registry
(out of scope for F.3).
"""

from __future__ import annotations

from logging import getLogger
from typing import List

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from controller.auth_controller import require_auth
from service.agent_types import DESCRIPTORS

logger = getLogger(__name__)

router = APIRouter(prefix="/api/subagent-types", tags=["subagent-types"])


class SubagentTypeRow(BaseModel):
    agent_type: str
    description: str = ""
    allowed_tools: List[str] = Field(default_factory=list)


class SubagentTypeListResponse(BaseModel):
    types: List[SubagentTypeRow] = Field(default_factory=list)


@router.get("", response_model=SubagentTypeListResponse)
async def list_subagent_types(_auth: dict = Depends(require_auth)):
    rows: List[SubagentTypeRow] = []
    for d in DESCRIPTORS:
        rows.append(SubagentTypeRow(
            agent_type=str(getattr(d, "agent_type", "")),
            description=str(getattr(d, "description", "") or ""),
            allowed_tools=list(getattr(d, "allowed_tools", []) or []),
        ))
    return SubagentTypeListResponse(types=rows)
