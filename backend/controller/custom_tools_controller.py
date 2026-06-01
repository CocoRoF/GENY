"""Custom Tools Controller — REST API for DB-backed user tools.

PR #2 (Phase B) of the Custom Tools rollout (cycle 20260525_1). CRUD
on the ``custom_tools`` table backing :class:`CustomToolDefinition`
rows. Every mutation triggers a :meth:`ToolLoader.reload_custom_tools_db`
pass so the active session pool picks up the new roster on the next
turn — no process restart.

Auth: standard ``require_auth`` (single-admin). The endpoint surface
intentionally mirrors ``skills_controller`` and ``mcp_custom_controller``
so the frontend RegistryPageShell pattern works unchanged.
"""

from __future__ import annotations

from logging import getLogger
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from controller.auth_controller import require_auth
from service.custom_tools import (
    CustomToolDefinition,
    HttpToolConfig,
    McpProxyConfig,
    BuiltinAliasConfig,
    PythonInlineConfig,
    get_custom_tool_store,
)
from service.custom_tools.models import ToolCapabilities
from service.custom_tools.store import (
    CustomToolNameTaken,
    CustomToolNotFound,
)

logger = getLogger(__name__)

router = APIRouter(prefix="/api/custom-tools", tags=["custom-tools"])


# ── Request / response shapes ──────────────────────────────────────


class CustomToolPayload(BaseModel):
    """Create / replace request body. Mirrors CustomToolDefinition but
    omits server-managed fields (id, created_at, updated_at, is_sample)."""

    name: str
    description: str
    input_schema: Dict[str, Any] = Field(default_factory=dict)
    backend_kind: Literal["http", "mcp_proxy", "builtin_alias", "python_inline"]
    config: Dict[str, Any]
    capabilities: Optional[Dict[str, Any]] = None
    enabled: bool = True


class CustomToolSummary(BaseModel):
    """List-endpoint row — omits the full schema/config blob to keep
    the listing payload small."""

    id: str
    name: str
    description: str
    backend_kind: str
    enabled: bool
    is_sample: bool


class CustomToolDetail(CustomToolSummary):
    """Full row — used by GET single + after-create/replace."""

    input_schema: Dict[str, Any]
    config: Dict[str, Any]
    capabilities: Dict[str, Any]


class CustomToolListResponse(BaseModel):
    tools: List[CustomToolSummary]


class EnabledToggleRequest(BaseModel):
    enabled: bool


class CustomToolTestRequest(BaseModel):
    """``test`` endpoint accepts the LLM-style args dict + optional
    ``dry_run`` flag. Dry-run validates arg shape against the schema
    without invoking the backend; real run dispatches the adapter."""

    arguments: Dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = True


class CustomToolTestResponse(BaseModel):
    ok: bool
    result: Optional[str] = None
    error: Optional[str] = None
    duration_ms: Optional[int] = None


# ── Helpers ────────────────────────────────────────────────────────


def _parse_config(kind: str, raw: Dict[str, Any]):
    """Map ``backend_kind`` to its config model."""
    cls_map = {
        "http": HttpToolConfig,
        "mcp_proxy": McpProxyConfig,
        "builtin_alias": BuiltinAliasConfig,
        "python_inline": PythonInlineConfig,
    }
    cls = cls_map.get(kind)
    if cls is None:
        raise HTTPException(
            status_code=400, detail=f"unknown backend_kind: {kind!r}",
        )
    try:
        return cls.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc


def _build_definition(payload: CustomToolPayload, *, id_: Optional[str] = None) -> CustomToolDefinition:
    cfg = _parse_config(payload.backend_kind, payload.config)
    caps = ToolCapabilities.model_validate(payload.capabilities or {})
    kwargs: Dict[str, Any] = dict(
        name=payload.name,
        description=payload.description,
        input_schema=payload.input_schema,
        backend_kind=payload.backend_kind,
        config=cfg,
        capabilities=caps,
        enabled=payload.enabled,
    )
    if id_ is not None:
        kwargs["id"] = id_
    try:
        return CustomToolDefinition(**kwargs)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors()) from exc


def _to_summary(d: CustomToolDefinition) -> CustomToolSummary:
    return CustomToolSummary(
        id=d.id,
        name=d.name,
        description=d.description,
        backend_kind=d.backend_kind,
        enabled=d.enabled,
        is_sample=d.is_sample,
    )


def _to_detail(d: CustomToolDefinition) -> CustomToolDetail:
    return CustomToolDetail(
        id=d.id,
        name=d.name,
        description=d.description,
        backend_kind=d.backend_kind,
        enabled=d.enabled,
        is_sample=d.is_sample,
        input_schema=d.input_schema,
        config=d.config.model_dump(),
        capabilities=d.capabilities.model_dump(),
    )


def _hot_reload_loader() -> None:
    """Push the store change into the live ToolLoader so sessions
    created from this moment on see the new roster."""
    try:
        from service.executor.agent_session_manager import get_agent_session_manager

        mgr = get_agent_session_manager()
        loader = getattr(mgr, "_tool_loader", None)
        if loader is not None and hasattr(loader, "reload_custom_tools_db"):
            loader.reload_custom_tools_db()
    except Exception as exc:  # noqa: BLE001
        logger.warning("custom_tools: hot-reload failed (continuing): %s", exc)


# ── Endpoints ──────────────────────────────────────────────────────


@router.get("", response_model=CustomToolListResponse)
async def list_custom_tools(_auth: dict = Depends(require_auth)):
    """List every custom tool — enabled + disabled, samples + user."""
    store = get_custom_tool_store()
    return CustomToolListResponse(tools=[_to_summary(d) for d in store.list_all()])


@router.get("/{tool_id}", response_model=CustomToolDetail)
async def get_custom_tool(tool_id: str, _auth: dict = Depends(require_auth)):
    store = get_custom_tool_store()
    try:
        return _to_detail(store.get(tool_id))
    except CustomToolNotFound:
        raise HTTPException(status_code=404, detail=f"custom tool not found: {tool_id}")


@router.post("", response_model=CustomToolDetail)
async def create_custom_tool(
    payload: CustomToolPayload, _auth: dict = Depends(require_auth),
):
    defn = _build_definition(payload)
    store = get_custom_tool_store()
    try:
        created = store.create(defn)
    except CustomToolNameTaken:
        raise HTTPException(
            status_code=409,
            detail=f"tool name already exists: {payload.name!r}",
        )
    _hot_reload_loader()
    return _to_detail(created)


@router.put("/{tool_id}", response_model=CustomToolDetail)
async def replace_custom_tool(
    tool_id: str,
    payload: CustomToolPayload,
    _auth: dict = Depends(require_auth),
):
    defn = _build_definition(payload, id_=tool_id)
    store = get_custom_tool_store()
    try:
        updated = store.replace(tool_id, defn)
    except CustomToolNotFound:
        raise HTTPException(status_code=404, detail=f"custom tool not found: {tool_id}")
    except CustomToolNameTaken:
        raise HTTPException(
            status_code=409,
            detail=f"tool name already exists: {payload.name!r}",
        )
    _hot_reload_loader()
    return _to_detail(updated)


@router.delete("/{tool_id}")
async def delete_custom_tool(tool_id: str, _auth: dict = Depends(require_auth)):
    store = get_custom_tool_store()
    try:
        store.delete(tool_id)
    except CustomToolNotFound:
        raise HTTPException(status_code=404, detail=f"custom tool not found: {tool_id}")
    _hot_reload_loader()
    return {"ok": True}


@router.patch("/{tool_id}/enabled", response_model=CustomToolDetail)
async def toggle_enabled(
    tool_id: str,
    payload: EnabledToggleRequest,
    _auth: dict = Depends(require_auth),
):
    store = get_custom_tool_store()
    try:
        updated = store.set_enabled(tool_id, payload.enabled)
    except CustomToolNotFound:
        raise HTTPException(status_code=404, detail=f"custom tool not found: {tool_id}")
    _hot_reload_loader()
    return _to_detail(updated)


@router.post("/{tool_id}/duplicate", response_model=CustomToolDetail)
async def duplicate_custom_tool(
    tool_id: str, _auth: dict = Depends(require_auth),
):
    """Clone a tool (typical use: fork a sample into a user-owned copy).

    Generates a fresh id, appends a unique suffix to ``name`` so the
    copy doesn't collide with the source. ``is_sample`` is always
    cleared on the clone.
    """
    store = get_custom_tool_store()
    try:
        original = store.get(tool_id)
    except CustomToolNotFound:
        raise HTTPException(status_code=404, detail=f"custom tool not found: {tool_id}")

    # Find an unused name. Start with "<name>_copy" then add a numeric
    # suffix until we hit a free slot.
    base = f"{original.name}_copy"
    name = base
    counter = 2
    while store.get_by_name(name) is not None:
        name = f"{base}_{counter}"
        counter += 1
        if counter > 100:
            raise HTTPException(
                status_code=409,
                detail="could not find free name slot for duplicate",
            )

    import uuid

    cloned = original.model_copy(deep=True)
    cloned.id = uuid.uuid4().hex
    cloned.name = name
    cloned.is_sample = False
    created = store.create(cloned)
    _hot_reload_loader()
    return _to_detail(created)


@router.post("/{tool_id}/test", response_model=CustomToolTestResponse)
async def test_custom_tool(
    tool_id: str,
    payload: CustomToolTestRequest,
    _auth: dict = Depends(require_auth),
):
    """Validate / invoke a custom tool for the operator's preview step.

    ``dry_run=True`` (default) only validates that the supplied
    ``arguments`` would pass the tool's input_schema. ``dry_run=False``
    actually builds the adapter and dispatches it — used for the
    "Real-call" preview button in the Custom Tools wizard.
    """
    import jsonschema
    import time

    store = get_custom_tool_store()
    try:
        defn = store.get(tool_id)
    except CustomToolNotFound:
        raise HTTPException(status_code=404, detail=f"custom tool not found: {tool_id}")

    try:
        jsonschema.validate(payload.arguments, defn.input_schema)
    except jsonschema.ValidationError as exc:
        return CustomToolTestResponse(ok=False, error=f"schema: {exc.message}")
    except Exception as exc:  # noqa: BLE001
        return CustomToolTestResponse(ok=False, error=f"schema error: {exc}")

    if payload.dry_run:
        return CustomToolTestResponse(ok=True, result="(dry-run) schema OK")

    # Real call — build adapter via the live ToolLoader so
    # ``builtin_alias`` rows can resolve their source class.
    try:
        from service.executor.agent_session_manager import get_agent_session_manager
        from service.custom_tools.adapters import build_adapter

        mgr = get_agent_session_manager()
        loader = getattr(mgr, "_tool_loader", None)
        builtin_lookup = loader.get_all_tools() if loader is not None else {}
        adapter = build_adapter(defn, builtin_lookup=builtin_lookup)
    except Exception as exc:  # noqa: BLE001
        return CustomToolTestResponse(ok=False, error=f"adapter build failed: {exc}")

    t0 = time.monotonic()
    try:
        result = await adapter.arun(**payload.arguments)
        elapsed = int((time.monotonic() - t0) * 1000)
        return CustomToolTestResponse(
            ok=True,
            result=result if isinstance(result, str) else str(result),
            duration_ms=elapsed,
        )
    except Exception as exc:  # noqa: BLE001
        elapsed = int((time.monotonic() - t0) * 1000)
        return CustomToolTestResponse(
            ok=False, error=str(exc), duration_ms=elapsed,
        )
