"""env_defaults — REST surface for the per-environment "default-on"
toggle that lives across hooks/skills/permissions/mcp_servers.

Storage flows through `service.env_defaults.EnvDefaultsService` →
`db_config_helper` → `persistent_configs` table. No file I/O — the
operator's earlier directive: DB-managed, not file-managed.

Design notes
============
* **Read returns every category in one call.** The env-management
  page renders all four registry tabs side-by-side; a single GET
  spares us four round-trips on tab switch.

* **Writes are by-category.** Replacing one list at a time matches
  the tab UX (each registry's "save" button is local) and keeps
  conflicts between tabs from clobbering each other's progress.

* **Toggle endpoint is convenience.** The picker rows have a
  per-row star button — POST to toggle one id, response carries
  the new full list so the client re-renders in one round-trip.

* **DB unavailable → 503.** This feature genuinely cannot work
  without persistence. Returning empty lists silently would let
  the user save a default that vanishes on next page load. The
  frontend explicitly degrades when this endpoint 503s — the
  picker still renders, the star toggle is greyed out, and a
  banner explains the situation.

The controller intentionally does NOT validate that submitted ids
exist in the corresponding host registry. Two reasons:

1. The host registries change independently — a user can delete a
   skill without our endpoint knowing — and the next get_all() call
   would surface a stale id we'd refuse to load. Better to treat
   the registry as the source of truth for *existence* and let the
   defaults list lag.

2. Cross-controller validation would couple this thin facade to
   four heavier services (HookService, SkillsService, etc.) for
   marginal benefit. The frontend filters stale ids before
   displaying, so the user never sees garbage.
"""

from __future__ import annotations

from logging import getLogger
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth
from service.env_defaults import SUPPORTED_CATEGORIES
from service.env_defaults.service import EnvDefaultsService

logger = getLogger(__name__)

router = APIRouter(prefix="/api/env-defaults", tags=["env-defaults"])


# ── Schemas ──────────────────────────────────────────────


class EnvDefaultsResponse(BaseModel):
    """Every supported category, as id-lists.

    Empty list for a category means "uncurated" — the frontend's
    new-draft seeder treats it as wildcard (every item default-on).
    """

    hooks: List[str] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    permissions: List[str] = Field(default_factory=list)
    mcp_servers: List[str] = Field(default_factory=list)


class CategorySetPayload(BaseModel):
    """Replace a category's id list outright."""

    ids: List[str] = Field(default_factory=list)


class CategoryResponse(BaseModel):
    """Single-category read or post-mutation echo."""

    category: str
    ids: List[str]


# ── Helpers ──────────────────────────────────────────────


def _service_or_503(request: Request) -> EnvDefaultsService:
    """Resolve the service or 503 if the DB isn't configured.

    See the module docstring for why we surface a hard error
    instead of degrading silently.
    """
    app_db = getattr(request.app.state, "app_db", None)
    if app_db is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "env-defaults requires the database backend; the server "
                "is running without an attached AppDatabaseManager."
            ),
        )
    return EnvDefaultsService(app_db)


def _validate_category(category: str) -> None:
    if category not in SUPPORTED_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported category {category!r}. "
                f"Supported: {sorted(SUPPORTED_CATEGORIES)}"
            ),
        )


# ── Endpoints ────────────────────────────────────────────


@router.get("", response_model=EnvDefaultsResponse)
async def get_env_defaults(
    request: Request,
    _auth: dict = Depends(require_auth),
) -> EnvDefaultsResponse:
    """All four categories in a single response."""
    svc = _service_or_503(request)
    data = svc.get_all()
    return EnvDefaultsResponse(
        hooks=data.get("hooks", []),
        skills=data.get("skills", []),
        permissions=data.get("permissions", []),
        mcp_servers=data.get("mcp_servers", []),
    )


@router.get("/{category}", response_model=CategoryResponse)
async def get_category(
    category: str,
    request: Request,
    _auth: dict = Depends(require_auth),
) -> CategoryResponse:
    """Single-category read — useful when only one tab is mounted."""
    _validate_category(category)
    svc = _service_or_503(request)
    return CategoryResponse(category=category, ids=svc.get(category))


@router.put("/{category}", response_model=CategoryResponse)
async def set_category(
    category: str,
    payload: CategorySetPayload,
    request: Request,
    _auth: dict = Depends(require_auth),
) -> CategoryResponse:
    """Replace the id list for *category* outright.

    Empty body (`{"ids": []}`) is a valid "reset to uncurated"
    operation — the frontend exposes it as the "기본값 초기화"
    button. Don't use DELETE for this; semantically the row still
    exists with an empty value list.
    """
    _validate_category(category)
    svc = _service_or_503(request)
    ok = svc.set(category, payload.ids)
    if not ok:
        raise HTTPException(
            status_code=503,
            detail="Failed to persist env-defaults; database write failed.",
        )
    return CategoryResponse(category=category, ids=svc.get(category))


@router.post("/{category}/toggle/{item_id:path}", response_model=CategoryResponse)
async def toggle_category_item(
    category: str,
    item_id: str,
    request: Request,
    _auth: dict = Depends(require_auth),
) -> CategoryResponse:
    """Add *item_id* if absent, remove if present.

    The :path converter on `item_id` is intentional — hook ids
    contain `::` and full command lines, which would otherwise
    fight FastAPI's segment parsing. The frontend URL-encodes
    the id before sending.
    """
    _validate_category(category)
    svc = _service_or_503(request)
    new_list = svc.toggle(category, item_id)
    if new_list is None:
        raise HTTPException(
            status_code=503,
            detail="Failed to persist env-defaults; database write failed.",
        )
    return CategoryResponse(category=category, ids=new_list)
