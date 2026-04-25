"""Skills Controller — REST API for the SKILL.md registry (G7.4).

Read-only endpoint that surfaces every loaded skill (bundled + user)
so the frontend slash-command panel knows which ``/<skill-id>``
commands resolve. The actual SkillTool invocation happens through
the regular tool_use path (the frontend rewrites ``/<skill-id> args``
into a ``skill__<id>`` tool call before sending the prompt).
"""

from __future__ import annotations

from logging import getLogger
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from controller.auth_controller import require_auth
from service.skills import list_skills

logger = getLogger(__name__)

router = APIRouter(prefix="/api/skills", tags=["skills"])


class SkillSummary(BaseModel):
    id: Optional[str] = Field(None, description="Skill id — used as slash command")
    name: Optional[str] = Field(None, description="Display name")
    description: Optional[str] = Field(None, description="Short description")
    model: Optional[str] = Field(None, description="Optional model override")
    allowed_tools: List[str] = Field(default_factory=list)


class SkillListResponse(BaseModel):
    skills: List[SkillSummary]


@router.get("/list", response_model=SkillListResponse)
async def list_skills_endpoint(_auth: dict = Depends(require_auth)):
    """Return every skill currently registered for this Geny instance.

    Bundled skills always appear; user skills (under ``~/.geny/skills/``)
    appear only when ``GENY_ALLOW_USER_SKILLS=1`` was set when the
    process started — the env var is read at request time so a
    re-export takes effect on the next call without process restart.
    """
    return SkillListResponse(skills=[SkillSummary(**s) for s in list_skills()])
