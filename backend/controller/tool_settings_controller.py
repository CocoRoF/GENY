"""Tool-settings schemas API.

Exposes the registered per-environment tool-setting schemas so the environment
editor can render their forms. Values themselves live on the environment
manifest (``host_selections.extras.tool_settings``) and are saved with the
manifest — there is no per-value endpoint here.

- GET /api/tool-settings/schemas — all registered tool-setting schemas
"""

from logging import getLogger
from typing import Any, Dict, List

from fastapi import APIRouter, Depends

from service.auth.auth_middleware import require_auth
from service.tool_settings import get_tool_setting_schemas

logger = getLogger(__name__)

router = APIRouter(prefix="/api/tool-settings", tags=["tool-settings"])


@router.get("/schemas")
async def list_tool_setting_schemas(auth: dict = Depends(require_auth)) -> Dict[str, List[Dict[str, Any]]]:
    """Return every registered tool-setting schema (form metadata for the UI)."""
    return {"schemas": get_tool_setting_schemas()}
