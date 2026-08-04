"""
Agent Session Controller

REST API endpoints for AgentSession (geny-executor Pipeline) management.

AgentSession API: /api/agents
"""
import asyncio
import json
import time
from logging import getLogger
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, Request, UploadFile
from starlette.responses import StreamingResponse
from pydantic import BaseModel, Field

from service.auth.auth_middleware import require_auth

from service.sessions.models import (
    CreateSessionRequest,
    SessionInfo,
    SessionRole,
    ExecuteRequest,
    ExecuteResponse,
    StorageFile,
    StorageListResponse,
    StorageFileContent,
)
from service.executor import (
    get_agent_session_manager,
    AgentSession,
)
from service.lifecycle import LifecycleEvent
from service.logging.session_logger import get_session_logger
from service.sessions.store import get_session_store
from service.execution.agent_executor import (
    execute_command,
    start_command_background,
    get_execution_holder,
    cleanup_execution,
    AgentNotFoundError,
    AgentNotAliveError,
    AlreadyExecutingError,
)

logger = getLogger(__name__)

# Create router
router = APIRouter(prefix="/api/agents", tags=["agents"])

# AgentSessionManager singleton
agent_manager = get_agent_session_manager()


def _enforce_session_owner(session_id: str, auth: dict) -> None:
    """Ownership guard for /api/agents/{session_id}/* (audit S6).

    Resolves the session's owner cheaply from the store record (which now
    persists ``owner_username``), falling back to a live in-memory agent,
    then delegates to ``verify_session_ownership`` (403 on mismatch,
    fail-open on unknown owner, admin bypass). Single-admin deployments
    are unaffected — the owner always matches the caller.
    """
    from service.auth.auth_middleware import verify_session_ownership

    owner = None
    try:
        rec = get_session_store().get(session_id)
        if isinstance(rec, dict):
            owner = rec.get("owner_username")
    except Exception:  # noqa: BLE001 — never fail the request on lookup error
        owner = None
    if owner is None:
        try:
            live = agent_manager.get_agent(session_id)
        except Exception:  # noqa: BLE001
            live = None
        if live is not None:
            owner = getattr(live, "owner_username", None)
    verify_session_ownership(auth, owner)


# ============================================================================
# Request/Response Models
# ============================================================================


class CreateAgentRequest(CreateSessionRequest):
    """
    Request to create an AgentSession.

    Inherits from CreateSessionRequest and provides additional options.
    """
    enable_checkpointing: bool = Field(
        default=False,
        description="Enable state checkpointing for replay/resume"
    )
    env_id: Optional[str] = Field(
        default=None,
        description=(
            "EnvironmentManifest id — when set, the pipeline is built from "
            "the stored manifest instead of the GenyPresets path."
        ),
    )
    memory_config: Optional[dict] = Field(
        default=None,
        description=(
            "Per-session memory tuning overrides. May include a ``tuning`` "
            "sub-object with ``max_inject_chars`` / ``recent_turns`` / "
            "``enable_vector_search`` / ``enable_reflection`` to override "
            "the settings.json:memory.tuning defaults for this session only."
        ),
    )
    trigger_preset_id: Optional[str] = Field(
        default=None,
        description=(
            "Trigger preset id — VTuber sessions only. When set, the "
            "thinking-trigger runtime reads timing / phases / categories "
            "from the named preset; ``None`` keeps the bundled defaults. "
            "The frontend manages presets via the '트리거 관리' tab."
        ),
    )


class AgentInvokeRequest(BaseModel):
    """
    Request to invoke an AgentSession.

    Executes the session's `geny-executor` Pipeline.
    """
    input_text: str = Field(
        ...,
        description="Input text for the agent"
    )
    thread_id: Optional[str] = Field(
        default=None,
        description="Thread ID for checkpointing (optional)"
    )
    max_iterations: Optional[int] = Field(
        default=None,
        description="Maximum graph iterations"
    )


class AgentInvokeResponse(BaseModel):
    """
    Response from an AgentSession invoke.
    """
    success: bool
    session_id: str
    output: Optional[str] = None
    error: Optional[str] = None
    thread_id: Optional[str] = None


class AgentStateResponse(BaseModel):
    """
    Response for an AgentSession state query.
    """
    session_id: str
    current_step: Optional[str] = None
    last_output: Optional[str] = None
    iteration: Optional[int] = None
    error: Optional[str] = None
    is_complete: bool = False


# ============================================================================
# Agent Session Management API
# ============================================================================


@router.post("", response_model=SessionInfo)
async def create_agent_session(request: CreateAgentRequest, auth: dict = Depends(require_auth)):
    """
    Create a new AgentSession.

    AgentSession wraps a `geny-executor` Pipeline and manages its
    lifecycle (tool attach, memory integration, idle monitoring).
    """
    try:
        owner_username = auth.get("sub", "anonymous")
        agent = await agent_manager.create_agent_session(
            request=request,
            enable_checkpointing=request.enable_checkpointing,
            owner_username=owner_username,
            env_id=request.env_id,
            memory_config=request.memory_config,
            trigger_preset_id=request.trigger_preset_id,
        )

        session_info = agent.get_session_info()
        logger.info(f"✅ AgentSession created: {agent.session_id}")
        return session_info

    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except LookupError as e:
        # EnvironmentNotFoundError when env_id references a missing manifest.
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"❌ Failed to create AgentSession: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _enrich_env_fields(data: dict) -> None:
    """Resolve model / provider / env name from the ENVIRONMENT manifest for
    store-backed (dormant) records — mirrors AgentSession.get_info: the
    manifest is what actually runs, so a stored legacy claude-* model must
    not shadow a non-Anthropic environment."""
    env_id = data.get("env_id")
    if not env_id:
        return
    try:
        from service.environment import get_environment_service

        svc = get_environment_service()
        manifest = svc.load_manifest(env_id) if svc else None
        if manifest is None:
            return
        if not data.get("env_name"):
            data["env_name"] = (manifest.metadata.name or "").strip() or None
        env_model = ((manifest.model or {}).get("model") or "").strip() or None
        for entry in manifest.stage_entries():
            if entry.order != 6 or entry.name != "api":
                continue
            if entry.active:
                data["model_provider"] = str(
                    (entry.config or {}).get("provider")
                    or (entry.strategies or {}).get("provider")
                    or ""
                ).strip() or None
                # Stage-6 커스텀 model override beats the pipeline-wide model
                # at runtime — mirror that priority in the display.
                override_model = (
                    (entry.model_override or {}).get("model") or ""
                ).strip() or None
                if override_model:
                    env_model = override_model
            break
        if env_model:
            data["model"] = env_model
    except Exception:  # noqa: BLE001 — enrichment must never break listing
        logger.debug("dormant env enrichment failed", exc_info=True)


def _dormant_session_info(rec: dict) -> Optional[SessionInfo]:
    """Build a ``SessionInfo`` for a session that exists in the persistent
    store but is not currently live in memory (dormant after a restart).

    Records are serialized ``SessionInfo`` dumps (+ store bookkeeping keys),
    so we filter to known fields and validate. Status is normalized to
    ``stopped`` (restorable) except ``error`` is preserved so failed sessions
    still surface in the UI's error count.
    """
    try:
        fields = set(SessionInfo.model_fields.keys())
        data = {k: v for k, v in rec.items() if k in fields}
        if not data.get("session_id"):
            return None
        stored = str(rec.get("status") or "stopped")
        data["status"] = "error" if stored == "error" else "stopped"
        _enrich_env_fields(data)
        return SessionInfo.model_validate(data)
    except Exception as e:  # noqa: BLE001 — never let one bad record break the list
        logger.debug(f"Skipping dormant session record: {e}")
        return None


@router.get("", response_model=List[SessionInfo])
async def list_agent_sessions(auth: dict = Depends(require_auth)):
    """
    List all sessions — live (in memory) + dormant (persisted, awaiting
    lazy re-hydration after a restart).

    Lazy restore (session-persistence): the live registry starts empty on
    every boot, so the list is the UNION of in-memory ``AgentSession``s and
    non-deleted store records that aren't live yet. Dormant sessions render
    with ``status="stopped"`` and re-hydrate on first access (open / message
    / ``POST /{id}/resume``). This is what makes sessions survive a redeploy,
    restart, or crash.

    Auth (R7 / audit 20260425_3 §1.5): the listing exposes session
    names + roles + statuses, which is operator-relevant metadata.
    """
    agents = agent_manager.list_agents()
    live = {a.session_id: a.get_session_info() for a in agents}

    merged: List[SessionInfo] = list(live.values())
    try:
        store = get_session_store()
        for rec in store.list_active():
            sid = rec.get("session_id")
            if not sid or sid in live:
                continue
            info = _dormant_session_info(rec)
            if info is not None:
                merged.append(info)
    except Exception as e:  # noqa: BLE001 — degrade to live-only on store failure
        logger.warning(f"Could not merge dormant sessions into list: {e}")

    return merged


# ============================================================================
# Session Store API (MUST be before /{session_id} to avoid path capture)
# ============================================================================


@router.get("/store/deleted", response_model=List[dict])
async def list_deleted_sessions(auth: dict = Depends(require_auth)):
    """
    List all soft-deleted sessions from the persistent store.

    Auth (R7): same rationale as ``list_agent_sessions``.
    """
    store = get_session_store()
    return store.list_deleted()


@router.get("/store/all", response_model=List[dict])
async def list_all_stored_sessions(auth: dict = Depends(require_auth)):
    """
    List ALL sessions from the persistent store (active + deleted).

    Auth (R7): same rationale as ``list_agent_sessions``.
    """
    store = get_session_store()
    return store.list_all()


@router.delete("/store/deleted")
async def purge_deleted_sessions(auth: dict = Depends(require_auth)):
    """
    Permanently delete ALL soft-deleted sessions — empties the trash.

    Irreversible: each record is removed from the store (DB + JSON) and its
    on-disk storage directory (memory, transcripts, checkpoints) is deleted.
    Powers the "전체 삭제 / Delete all" button in the deleted-sessions list.
    Live (non-deleted) sessions are never touched.
    """
    import shutil
    from pathlib import Path as FilePath

    store = get_session_store()
    deleted_records = store.list_deleted()

    purged = 0
    errors = 0
    for rec in deleted_records:
        sid = rec.get("session_id")
        if not sid:
            continue
        try:
            storage_path = rec.get("storage_path")
            if storage_path:
                sp = FilePath(storage_path)
                if sp.is_dir():
                    try:
                        shutil.rmtree(sp)
                    except Exception as e:  # noqa: BLE001 — best effort
                        logger.warning(f"Failed to cleanup storage {storage_path}: {e}")
            if store.permanent_delete(sid):
                purged += 1
        except Exception as e:  # noqa: BLE001 — never let one bad record abort the purge
            errors += 1
            logger.warning(f"Failed to purge deleted session {sid}: {e}")

    logger.info(f"🗑️ Purged {purged} soft-deleted sessions ({errors} errors)")
    return {"success": True, "purged": purged, "errors": errors}


@router.get("/store/{session_id}")
async def get_stored_session_info(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """
    Get detailed metadata for any session (active or deleted) from the store.
    """
    store = get_session_store()
    record = store.get(session_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found in store")

    # Resolve effective model name if not stored
    if not record.get("model"):
        import os
        effective_model = os.environ.get('ANTHROPIC_MODEL')
        if not effective_model:
            try:
                from service.config.manager import get_config_manager
                from service.config.sub_config.general.api_config import APIConfig
                api_cfg = get_config_manager().load_config(APIConfig)
                effective_model = api_cfg.anthropic_model or None
            except Exception:
                pass
        if effective_model:
            record["model"] = effective_model

    return record


# ============================================================================
# Session CRUD (with /{session_id} path parameter)
# ============================================================================


@router.get("/storage/summary")
async def storage_summary(auth: dict = Depends(require_auth)):
    """Per-agent workspace usage for every session the caller owns.

    The Drive UI shows a usage bar per connected agent; without this it
    would issue one /storage/changes per agent just to read used_bytes.
    Sizes are computed off-loop (directory walks) and failures degrade to
    a null size rather than failing the whole listing.
    """
    from service.utils import workspace_sync

    out: List[Dict[str, Any]] = []
    quota = workspace_sync.quota_bytes()
    try:
        records = get_session_store().list_all() or []
    except Exception:  # noqa: BLE001
        records = []
    seen: set = set()
    for rec in records:
        sid = str(rec.get("session_id") or "")
        if not sid or sid in seen or rec.get("is_deleted"):
            continue
        seen.add(sid)
        try:
            _enforce_session_owner(sid, auth)
        except HTTPException:
            continue  # not the caller's session — omit silently
        try:
            storage_path = _storage_root_live_or_dormant(sid)
            used = await asyncio.to_thread(workspace_sync.used_bytes, storage_path)
        except Exception:  # noqa: BLE001
            used = None
        out.append(
            {
                "session_id": sid,
                "session_name": rec.get("session_name"),
                "used_bytes": used,
                "quota_bytes": quota,
            }
        )
    return {"agents": out, "quota_bytes": quota}


@router.get("/{session_id}", response_model=SessionInfo)
async def get_agent_session(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """
    Get specific AgentSession information.

    Tolerates dormant (post-restart) sessions: if not live in memory, falls
    back to the persisted store record (status "stopped") instead of 404ing,
    so opening a session that hasn't been re-hydrated yet still shows its
    metadata. Actual re-hydration happens on message / explicit resume.
    """
    agent = agent_manager.get_agent(session_id)
    if not agent:
        store = get_session_store()
        rec = store.get(session_id)
        if rec and not rec.get("is_deleted"):
            info = _dormant_session_info(rec)
            if info is not None:
                return info
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    info = agent.get_session_info()
    # X7 (cycle 20260422_5): enrich with the Tamagotchi snapshot for
    # sessions that have a state_provider. Returns None for classic
    # sessions — the frontend UI hides the panel in that case.
    info.creature_state = await agent.load_creature_state_snapshot()
    return info


class UpdateSystemPromptRequest(BaseModel):
    """Request to update an agent's system prompt."""
    system_prompt: Optional[str] = Field(
        default=None,
        description="New system prompt. Set to null or empty string to clear.",
    )


class UpdateThinkingTriggerRequest(BaseModel):
    """Request to enable/disable thinking trigger for a session."""
    enabled: bool = Field(
        ...,
        description="Whether thinking trigger is enabled for this session.",
    )


class AttachTriggerPresetRequest(BaseModel):
    """Request to attach (or detach) a trigger preset for a VTuber session.

    Pass ``trigger_preset_id=None`` to revert the session to the bundled
    defaults. Idempotent — re-binding the same preset is a no-op.
    """

    trigger_preset_id: Optional[str] = Field(
        default=None,
        description=(
            "Trigger preset id, or ``null`` to detach and use the bundled "
            "defaults."
        ),
    )


class ChangeEnvRequest(BaseModel):
    """Request to rebind a session to a different environment.

    Targets exactly one session id (the path param). For a VTuber/Sub-Worker
    pair the caller issues two separate requests — one per session — so each
    side can run a different environment.
    """

    env_id: str = Field(..., description="The environment id to bind to.")


@router.put("/{session_id}/system-prompt")
async def update_system_prompt(
    request: UpdateSystemPromptRequest,
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """
    Update the system prompt of a running AgentSession.

    The new prompt takes effect on the next execution.
    Pass null or empty string to clear the system prompt.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    agent = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    new_prompt = request.system_prompt if request.system_prompt else None

    # Route through the PersonaProvider (cycle 20260421_7 PR-X1-3). The
    # provider replaces the legacy ``agent._system_prompt`` write; the
    # pipeline's DynamicPersonaSystemBuilder picks up the new override on
    # the next turn. Persisting to session_store is unchanged so restore
    # can re-stage the override.
    agent_manager.persona_provider.set_static_override(session_id, new_prompt)

    # Persist to session store so the change survives delete/restore
    store = get_session_store()
    store.update(session_id, {"system_prompt": new_prompt or ""})

    logger.info(
        f"[{session_id}] System prompt updated "
        f"({len(new_prompt) if new_prompt else 0} chars)"
    )
    return {"success": True, "session_id": session_id, "system_prompt_length": len(new_prompt) if new_prompt else 0}


@router.get("/{session_id}/thinking-trigger")
async def get_thinking_trigger(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Get thinking trigger status for a VTuber session."""
    from service.vtuber.thinking_trigger import get_thinking_trigger_service
    service = get_thinking_trigger_service()
    status = service.get_status(session_id)
    return {"session_id": session_id, **status}


@router.put("/{session_id}/thinking-trigger")
async def update_thinking_trigger(
    request: UpdateThinkingTriggerRequest,
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Enable or disable thinking trigger for a VTuber session."""
    from service.vtuber.thinking_trigger import get_thinking_trigger_service
    service = get_thinking_trigger_service()
    if request.enabled:
        service.enable(session_id)
    else:
        service.disable(session_id)
    return {"success": True, "session_id": session_id, **service.get_status(session_id)}


@router.put("/{session_id}/trigger-preset")
async def attach_trigger_preset(
    request: AttachTriggerPresetRequest,
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Attach (or detach) a trigger preset for a VTuber session.

    The trigger runtime starts using the new preset on the next tick —
    no restart required. ``trigger_preset_id=null`` reverts the session
    to the bundled default ladder.
    """
    agent = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    # Validate the preset exists (when one is requested) so the FE
    # surfaces a 404 instead of silently no-op'ing on a typo.
    if request.trigger_preset_id:
        from service.trigger_preset import get_trigger_preset_service
        svc = get_trigger_preset_service()
        if svc is not None and svc.get(request.trigger_preset_id) is None:
            raise HTTPException(
                status_code=404,
                detail=f"Trigger preset not found: {request.trigger_preset_id}",
            )

    from service.vtuber.thinking_trigger import get_thinking_trigger_service
    get_thinking_trigger_service().attach_preset(
        session_id, request.trigger_preset_id
    )

    # Persist on the session record so reverse-lookups + reads through
    # SessionStore reflect the change.
    try:
        store = get_session_store()
        store.update(session_id, {"trigger_preset_id": request.trigger_preset_id})
    except Exception:
        logger.debug(
            "[%s] Failed to persist trigger_preset_id; runtime binding "
            "still active",
            session_id,
            exc_info=True,
        )

    return {
        "success": True,
        "session_id": session_id,
        "trigger_preset_id": request.trigger_preset_id,
    }


@router.get("/{session_id}/sub-agent")
async def get_session_sub_agent(
    request: Request,
    session_id: str = Path(..., description="VTuber session ID"),
    auth: dict = Depends(require_auth),
):
    """View the executor persistent sub-agent owned by a VTuber session.

    The cutover (GENY_VTUBER_SUBAGENT_MODE=executor) makes a VTuber own a
    geny-executor persistent sub-agent rather than a bespoke paired session.
    It is not a session, so it has no sidebar entry — this read-only endpoint
    surfaces its status + recent conversation + pending notifications so the
    UI can render the "확인만" view (decision 4).
    """
    manager = getattr(request.app.state, "subagent_manager", None)
    if manager is None:
        raise HTTPException(status_code=503, detail="subagent_manager not configured")
    try:
        rec = get_session_store().get(session_id) or {}
    except Exception:
        rec = {}
    sa_id = rec.get("executor_sub_agent_id")
    if not sa_id:
        raise HTTPException(status_code=404, detail="session has no executor sub-agent")
    inbox_count = manager.inbox.count(session_id)
    agent = manager.get(sa_id)
    if agent is None:
        # Not live in-memory (e.g. before first access after restart).
        return {
            "sub_agent_id": sa_id,
            "owner_session_id": session_id,
            "status": "dormant",
            "conversation": [],
            "inbox_count": inbox_count,
        }
    summary = agent.summary()
    messages = [
        {"role": m.get("role"), "content": m.get("content")}
        for m in (getattr(agent.state, "messages", []) or [])[-20:]
    ]
    return {**summary, "conversation": messages, "inbox_count": inbox_count}


@router.put("/{session_id}/env")
async def change_session_env(
    request: ChangeEnvRequest,
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Rebind a session to a different environment.

    Works for both live and dormant (post-restart) sessions — the new
    binding is persisted to the store and a live session reloads its
    pipeline from the new manifest on the next access *between turns*
    (storage / memory / conversation are preserved). For a VTuber pair,
    call this once per session id (the VTuber's and the Sub-Worker's) to
    change each side independently.

    Returns 404 when the session is unknown, 400 when the target env is
    unknown or its provider has no credentials.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    try:
        result = await agent_manager.change_session_env(
            session_id, request.env_id
        )
    except ValueError as exc:
        msg = str(exc)
        status = 404 if "session not found" in msg else 400
        raise HTTPException(status_code=status, detail=msg)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"success": True, **result}


@router.delete("/{session_id}")
async def delete_agent_session(
    session_id: str = Path(..., description="Session ID"),
    cleanup_storage: bool = Query(False, description="Also delete storage (default: False to preserve files)"),
    auth: dict = Depends(require_auth),
):
    """
    Delete AgentSession (soft-delete — metadata preserved in sessions.json).

    Storage is preserved by default so the session can be restored later.
    Pass cleanup_storage=true to also remove the storage directory.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    success = await agent_manager.delete_session(session_id, cleanup_storage)
    if not success:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    logger.info(f"✅ AgentSession soft-deleted: {session_id}")
    return {"success": True, "session_id": session_id}


@router.delete("/{session_id}/permanent")
async def permanent_delete_session(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """
    Permanently delete a session from the persistent store.
    The session record is irrecoverably removed from sessions.json
    and its storage directory is deleted from disk.
    Cascades to linked sessions (VTuber ↔ CLI pairs).
    """
    import shutil
    from pathlib import Path as FilePath

    store = get_session_store()

    # Get record and find linked session before deleting
    record = store.get(session_id)
    storage_path = record.get("storage_path") if record else None
    linked_id = record.get("linked_session_id") if record else None

    # Also delete from live agents if still active
    if agent_manager.has_agent(session_id):
        await agent_manager.delete_session(session_id, cleanup_storage=True)
    elif storage_path:
        # Agent not live — clean up storage directory from disk
        sp = FilePath(storage_path)
        if sp.is_dir():
            try:
                shutil.rmtree(sp)
                logger.info(f"Storage cleaned up: {storage_path}")
            except Exception as e:
                logger.warning(f"Failed to cleanup storage {storage_path}: {e}")

    # GAPT workspace: a live session already archived it via delete_session,
    # but a dormant one (deleted post-restart) took the direct-rmtree branch
    # above and never touched GAPT. Call the idempotent helper unconditionally
    # so the agent's workspace is gone either way.
    try:
        from service.gapt import delete_workspace_for_session
        await delete_workspace_for_session(session_id)
    except Exception:  # noqa: BLE001 — never block permanent delete
        logger.debug(f"[{session_id}] gapt cleanup on permanent delete failed", exc_info=True)

    removed = store.permanent_delete(session_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found in store")
    logger.info(f"✅ Session permanently deleted: {session_id}")

    # Cascade to linked session (VTuber ↔ CLI pair)
    if linked_id:
        linked_rec = store.get(linked_id)
        if linked_rec:
            linked_storage = linked_rec.get("storage_path")
            if agent_manager.has_agent(linked_id):
                await agent_manager.delete_session(linked_id, cleanup_storage=True)
            elif linked_storage:
                sp = FilePath(linked_storage)
                if sp.is_dir():
                    try:
                        shutil.rmtree(sp)
                        logger.info(f"Linked session storage cleaned up: {linked_storage}")
                    except Exception as e:
                        logger.warning(f"Failed to cleanup linked storage {linked_storage}: {e}")
            try:
                from service.gapt import delete_workspace_for_session
                await delete_workspace_for_session(linked_id)
            except Exception:  # noqa: BLE001
                logger.debug(f"[{linked_id}] gapt cleanup on permanent delete failed", exc_info=True)
            store.permanent_delete(linked_id)
            logger.info(f"✅ Linked session permanently deleted: {linked_id}")

    return {"success": True, "session_id": session_id}


@router.post("/{session_id}/resume", response_model=SessionInfo)
async def resume_session(
    session_id: str = Path(..., description="Session ID to resume"),
    auth: dict = Depends(require_auth),
):
    """
    Resume a dormant session — idempotent lazy re-hydration.

    After a redeploy / restart / crash the live registry is empty but the
    session still exists in the store (non-deleted). This reconstructs the
    ``AgentSession`` from its on-disk storage (memory, transcripts,
    checkpoints) so the conversation continues, and cascades to the linked
    peer. If the session is already live it just returns the current info.
    The frontend calls this when the user opens a ``stopped`` session.
    """
    if agent_manager.has_agent(session_id):
        return agent_manager.get_agent(session_id).get_session_info()

    agent = await agent_manager.ensure_session_live(session_id)
    if agent is None:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found or was deleted — nothing to resume",
        )
    logger.info(f"✅ Session resumed: {session_id}")
    return agent.get_session_info()


@router.post("/{session_id}/restore")
async def restore_session(
    session_id: str = Path(..., description="Session ID to restore"),
    auth: dict = Depends(require_auth),
):
    """
    Restore a soft-deleted (explicitly removed) session.

    Un-deletes the store record, then re-creates the AgentSession with the
    same session_id (preserving storage_path) via the shared re-hydration
    path used by lazy restore. Cascades to linked sessions (VTuber ↔ CLI).
    """
    store = get_session_store()
    record = store.get(session_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found in store")
    if not record.get("is_deleted"):
        raise HTTPException(status_code=400, detail="Session is not deleted — nothing to restore")

    # Check not already live
    if agent_manager.has_agent(session_id):
        raise HTTPException(status_code=400, detail="Session is already running")

    # Un-delete first so the shared re-hydration path (which refuses deleted
    # records) accepts it; cascade un-delete the linked peer too.
    store.restore(session_id)
    linked_id = record.get("linked_session_id")
    if linked_id:
        linked_rec = store.get(linked_id)
        if linked_rec and linked_rec.get("is_deleted"):
            store.restore(linked_id)

    try:
        agent = await agent_manager._rehydrate(session_id)
        if agent is None:
            raise RuntimeError("re-hydration returned no session")
        session_info = agent.get_session_info()
        logger.info(f"✅ Session restored: {session_id} (same ID, storage preserved)")
        return session_info
    except Exception as e:
        logger.error(f"❌ Failed to restore session {session_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Agent Graph Execution API
# ============================================================================


@router.post("/{session_id}/invoke", response_model=AgentInvokeResponse)
async def invoke_agent(
    session_id: str = Path(..., description="Session ID"),
    request: AgentInvokeRequest = ...,
    auth: dict = Depends(require_auth),
):
    """
    Invoke AgentSession — runs the session's `geny-executor` Pipeline.

    If checkpointing is enabled, state is restored/saved using thread_id.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    # Hydrate-on-access: transparently re-hydrate a dormant (post-restart)
    # session so messaging a "stopped" session just resumes it.
    agent = await agent_manager.ensure_session_live(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    if not agent.is_initialized:
        raise HTTPException(
            status_code=400,
            detail=f"AgentSession is not initialized"
        )

    # Session logger
    session_logger = get_session_logger(session_id, create_if_missing=False)

    try:
        # Log input
        if session_logger:
            session_logger.log_command(
                prompt=request.input_text,
                max_turns=request.max_iterations,
            )

        # Run the session's Pipeline
        result = await agent.invoke(
            input_text=request.input_text,
            thread_id=request.thread_id,
            max_iterations=request.max_iterations,
        )
        output = result.get("output", "") if isinstance(result, dict) else str(result)

        # Log response
        if session_logger:
            session_logger.log_response(
                success=True,
                output=output,
            )

        return AgentInvokeResponse(
            success=True,
            session_id=session_id,
            output=output,
            thread_id=request.thread_id,
        )

    except Exception as e:
        logger.error(f"❌ Agent invoke failed: {e}", exc_info=True)

        if session_logger:
            session_logger.log_response(
                success=False,
                error=str(e),
            )

        return AgentInvokeResponse(
            success=False,
            session_id=session_id,
            error=str(e),
            thread_id=request.thread_id,
        )


@router.post("/{session_id}/execute", response_model=ExecuteResponse)
async def execute_agent_prompt(
    session_id: str = Path(..., description="Session ID"),
    request: ExecuteRequest = ...,
    auth: dict = Depends(require_auth),
):
    """
    Execute prompt with AgentSession via the compiled StateGraph.

    Delegates to the unified ``execute_command`` function which handles
    auto-revival, session logging, cost tracking, and double-execution
    prevention.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    try:
        result = await execute_command(
            session_id=session_id,
            prompt=request.prompt,
            timeout=request.timeout,
            system_prompt=request.system_prompt,
            max_turns=request.max_turns,
        )
        return ExecuteResponse(
            success=result.success,
            session_id=session_id,
            output=result.output,
            error=result.error,
            cost_usd=result.cost_usd,
            duration_ms=result.duration_ms,
        )
    except AgentNotFoundError:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")
    except AgentNotAliveError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except AlreadyExecutingError:
        raise HTTPException(status_code=409, detail="Execution already in progress")
    except Exception as e:
        logger.error(f"❌ Agent execute failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# NOTE: SSE helpers (_sse, _emit_avatar_state_for_log, _stream_execution_sse)
# and SSE endpoints (GET /execute/events, POST /execute/stream) have been removed.
# Execution streaming is now handled by ws/execute_stream.py (WebSocket).


async def _emit_avatar_state_for_log(entry_dict: dict, session_id: str, app_state) -> None:
    """
    Inspect a log entry and emit avatar state changes if relevant.

    Called during SSE streaming for each log entry to automatically
    update the Live2D avatar expression based on:
    1. LLM response text → emotion tag extraction ([joy], [anger], etc.)
    2. Agent execution state → state-to-emotion mapping
    """
    if not hasattr(app_state, "avatar_state_manager") or not hasattr(app_state, "live2d_model_manager"):
        return

    state_manager = app_state.avatar_state_manager
    model_manager = app_state.live2d_model_manager

    model = model_manager.get_agent_model(session_id)
    if not model:
        return

    level = entry_dict.get("level", "")
    message = entry_dict.get("message", "")

    try:
        from service.vtuber.emotion_extractor import EmotionExtractor
        extractor = EmotionExtractor(model.emotionMap)

        if level == "RESPONSE":
            # LLM response — extract emotion tags
            emotion, index = extractor.resolve_emotion(message, None)
            await state_manager.update_state(
                session_id=session_id,
                emotion=emotion,
                expression_index=index,
                trigger="agent_output",
            )
        elif level == "TOOL":
            # Tool usage — show "working" expression
            await state_manager.update_state(
                session_id=session_id,
                emotion="surprise",
                expression_index=model.emotionMap.get("surprise", 0),
                trigger="state_change",
            )
        elif level == "GRAPH":
            if "error" in message.lower() or "fail" in message.lower():
                await state_manager.update_state(
                    session_id=session_id,
                    emotion="fear",
                    expression_index=model.emotionMap.get("fear", 0),
                    trigger="state_change",
                )
            elif "complet" in message.lower() or "success" in message.lower():
                await state_manager.update_state(
                    session_id=session_id,
                    emotion="joy",
                    expression_index=model.emotionMap.get("joy", 0),
                    trigger="state_change",
                )
    except Exception:
        pass  # Avatar state is best-effort; never break the SSE stream



# ── Execution endpoints (delegating to agent_executor) ────────────────────────


@router.get("/{session_id}/execute/status")
async def get_execution_status(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """
    Lightweight polling endpoint — check whether an execution is active.

    Returns:
      - ``active: true``  + ``done`` flag while the holder exists.
      - ``active: false`` when there is no execution for this session.

    Designed for the frontend to call on page load / visibility-change
    so it can reconnect to ``GET /execute/events`` if needed.
    """
    holder = get_execution_holder(session_id)
    if not holder:
        return {"active": False, "session_id": session_id}

    now = time.time()
    start_time = holder.get("start_time", now)
    elapsed_ms = int((now - start_time) * 1000)

    # Compute last activity from session logger
    session_logger = get_session_logger(session_id, create_if_missing=False)
    now_mono = time.monotonic()
    last_write = session_logger.get_last_write_at() if session_logger else 0
    last_activity_ms = int((now_mono - last_write) * 1000) if last_write > 0 else elapsed_ms

    entry_info = session_logger.get_last_entry_info() if session_logger else {}

    return {
        "active": True,
        "done": holder.get("done", False),
        "has_error": holder.get("error") is not None,
        "session_id": session_id,
        "elapsed_ms": elapsed_ms,
        "last_activity_ms": last_activity_ms,
        "last_event_level": entry_info.get("level"),
        "last_tool_name": entry_info.get("tool_name"),
    }



# ============================================================================
# Agent State API
# ============================================================================


@router.get("/{session_id}/state", response_model=AgentStateResponse)
async def get_agent_state(
    session_id: str = Path(..., description="Session ID"),
    thread_id: Optional[str] = Query(None, description="Thread ID"),
    auth: dict = Depends(require_auth),
):
    """
    Get current AgentSession state.

    State can only be queried if checkpointing is enabled.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    agent = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    state = agent.get_state(thread_id=thread_id)

    if state is None:
        return AgentStateResponse(
            session_id=session_id,
            error="State not available (checkpointing disabled or no execution yet)",
        )

    metadata = state.get("metadata", {})

    return AgentStateResponse(
        session_id=session_id,
        current_step=state.get("current_step"),
        last_output=state.get("last_output"),
        iteration=metadata.get("iteration"),
        error=state.get("error"),
        is_complete=state.get("is_complete", False),
    )


@router.get("/{session_id}/history")
async def get_agent_history(
    session_id: str = Path(..., description="Session ID"),
    thread_id: Optional[str] = Query(None, description="Thread ID"),
    auth: dict = Depends(require_auth),
):
    """
    Get AgentSession execution history.

    History can only be queried if checkpointing is enabled.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    agent = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    history = agent.get_history(thread_id=thread_id)

    return {
        "session_id": session_id,
        "thread_id": thread_id,
        "history": history,
    }


# ============================================================================
# ============================================================================
# Stop Execution API
# ============================================================================


@router.post("/{session_id}/stop")
async def stop_execution(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """
    Stop the current execution for a session.

    Graph execution is synchronous — cancel the HTTP request to stop.
    This endpoint marks the intent to stop.
    """
    agent = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"AgentSession not found: {session_id}")

    logger.info(f"[{session_id}] Stop requested — graph execution is synchronous, cancel the HTTP request")
    return {
        "success": True,
        "message": "Graph executes synchronously. Cancel the HTTP request to stop execution.",
    }


# ============================================================================
# Storage API
# ============================================================================


def _storage_root_live_or_dormant(session_id: str) -> str:
    """Session storage root for live OR dormant sessions.

    Storage endpoints must keep working after a backend restart (lazy
    restore leaves sessions dormant until touched) — the files are on
    disk regardless of liveness, so fall back to the session store
    record when no live agent exists. 404 only for unknown/deleted ids.
    """
    agent = agent_manager.get_agent(session_id)
    storage_path = getattr(agent, "storage_path", None) if agent else None
    if not storage_path:
        record = None
        try:
            record = get_session_store().get(session_id)
        except Exception:  # noqa: BLE001 — store may be unavailable; fall through
            record = None
        if record and record.get("is_deleted"):
            raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
        if record:
            storage_path = record.get("storage_path")
    if not storage_path:
        # No live agent and no store record — but the session's files survive on
        # disk after the store record is idle-evicted / pruned, and storage
        # endpoints (download / preview / list) must keep serving them. Derive
        # <storage_root>/<session_id> when it actually exists. Validate the id to
        # a safe leaf so this can't traverse or probe arbitrary paths; the
        # per-endpoint owner guard still applies.
        import re as _re
        from pathlib import Path as _P

        from service.utils.platform import DEFAULT_STORAGE_ROOT

        if _re.match(r"^[A-Za-z0-9_-]{1,128}$", session_id):
            cand = _P(DEFAULT_STORAGE_ROOT) / session_id
            if cand.is_dir():
                storage_path = str(cand)
    if not storage_path:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
    return storage_path


@router.get("/{session_id}/storage")
async def list_storage_files(
    session_id: str = Path(..., description="Session ID"),
    path: str = Query("", description="Subdirectory path"),
    scope: str = Query(
        "all",
        description="'workspace' roots the listing at the agent's workspace/ "
                    "(the user-facing files); 'all' shows the whole session "
                    "dir including internal state (memory, transcripts, db).",
    ),
    auth: dict = Depends(require_auth),
):
    """
    List session storage files. Works for dormant sessions too.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    import os as _os

    from service.utils import file_storage as storage_utils

    storage_path = _storage_root_live_or_dormant(session_id)
    if scope == "workspace":
        storage_path = _os.path.join(storage_path, "workspace")
        _os.makedirs(storage_path, exist_ok=True)

    files_data = storage_utils.list_storage_files(
        storage_path, subpath=path, session_id=session_id
    )
    files = [StorageFile(**f) for f in files_data]

    return StorageListResponse(
        session_id=session_id,
        storage_path=storage_path,
        files=files
    )


#: Per-file cap for workspace writes (browser upload AND sync PUT).
#: Env-tunable so operators can raise/lower without a release; the
#: connector reads the same limit from /storage/changes responses.
def _workspace_max_file_bytes() -> int:
    import os as _os

    try:
        return int(_os.environ.get("GENY_WORKSPACE_MAX_FILE_MB", "500")) * 1024 * 1024
    except ValueError:
        return 500 * 1024 * 1024




async def _sync_touch(session_id: str, storage_path: str) -> int:
    """After any workspace write: refresh the sync index (off-loop —
    hashing/sqlite are blocking) and wake connected replicas. Returns the
    new latest_seq. Never raises — sync bookkeeping must not fail the
    user's operation."""
    try:
        from service.utils import workspace_sync
        from ws.workspace_stream import notify_workspace_changed

        stats = await asyncio.to_thread(
            workspace_sync.refresh_index, storage_path, session_id, force=True
        )
        seq = int(stats.get("latest_seq", 0))
        notify_workspace_changed(session_id, seq)
        return seq
    except Exception as exc:  # noqa: BLE001
        logger.debug("[%s] sync index refresh failed: %s", session_id, exc)
        return 0


def _workspace_target(session_id: str, rel_path: str) -> "tuple":
    """Resolve *rel_path* (storage-root-relative, e.g. 'workspace/uploads/x')
    and enforce that it stays INSIDE the session's workspace/ — the only
    place UI-driven writes are allowed. Internal state (memory/, transcripts/,
    synapse.db, checkpoints/) is never reachable from these endpoints."""
    from pathlib import Path as _P

    storage_path = _storage_root_live_or_dormant(session_id)
    root = _P(storage_path).resolve()
    ws = (root / "workspace").resolve()
    target = (root / (rel_path or "")).resolve()
    try:
        target.relative_to(ws)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="Write operations are allowed only inside workspace/",
        )
    if target == ws and rel_path.rstrip("/") != "workspace":
        # normalise edge: '' would resolve to root
        pass
    return root, ws, target


class StorageRenameRequest(BaseModel):
    src: str
    dst: str


@router.post("/{session_id}/storage/mkdir")
async def storage_mkdir(
    session_id: str = Path(..., description="Session ID"),
    path: str = Query(..., description="New folder path (storage-root relative, under workspace/)"),
    auth: dict = Depends(require_auth),
):
    """Create a folder inside the agent workspace (explorer 새 폴더)."""
    _enforce_session_owner(session_id, auth)
    root, _ws, target = _workspace_target(session_id, path)
    if target.exists():
        raise HTTPException(status_code=409, detail="Already exists")
    target.mkdir(parents=True, exist_ok=False)
    await _sync_touch(session_id, str(root))
    return {"ok": True, "path": str(target.relative_to(root))}


@router.post("/{session_id}/storage/rename")
async def storage_rename(
    request: StorageRenameRequest,
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Rename/move a file or folder within the workspace."""
    _enforce_session_owner(session_id, auth)
    from service.utils import workspace_sync

    root, ws, src = _workspace_target(session_id, request.src)
    _root2, _ws2, dst = _workspace_target(session_id, request.dst)
    if src == ws or dst == ws:
        raise HTTPException(status_code=403, detail="Cannot rename the workspace root")
    # Locked no-clobber rename: os.rename silently replaces an existing
    # dst on POSIX, so the exists-check must be atomic with the rename
    # against concurrent PUT/chunk commits.
    outcome = await asyncio.to_thread(workspace_sync.locked_rename, str(root), src, dst)
    if outcome == "src_missing":
        raise HTTPException(status_code=404, detail="Source not found")
    if outcome == "dst_exists":
        raise HTTPException(status_code=409, detail="Destination already exists")
    await _sync_touch(session_id, str(root))
    return {"ok": True, "path": str(dst.relative_to(root))}


@router.delete("/{session_id}/storage/entry")
async def storage_delete(
    session_id: str = Path(..., description="Session ID"),
    path: str = Query(..., description="Path to delete (under workspace/)"),
    base_sha: Optional[str] = Query(
        None,
        description="Sync guard: expected current sha256 of the file. "
        "Mismatch → 409 (someone changed it since the replica last saw it).",
    ),
    auth: dict = Depends(require_auth),
):
    """Delete a file or folder (recursive) inside the workspace."""
    _enforce_session_owner(session_id, auth)
    from service.utils import workspace_sync

    _root, ws, target = _workspace_target(session_id, path)
    if target == ws:
        raise HTTPException(status_code=403, detail="Cannot delete the workspace root")
    # Verify+delete under the storage lock (off-loop — rmtree of a big
    # tree must never stall the event loop), so a guarded delete can't
    # destroy a PUT that committed after the caller's pre-check.
    try:
        clash = await asyncio.to_thread(
            workspace_sync.locked_delete, str(_root), target, base_sha
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
    if clash is not None:
        raise HTTPException(
            status_code=409,
            detail={"conflict": "delete", "current_sha": clash},
        )
    await _sync_touch(session_id, str(_root))
    return {"ok": True}


@router.post("/{session_id}/storage/upload")
async def upload_to_workspace(
    session_id: str = Path(..., description="Session ID"),
    subdir: str = Query(
        "uploads",
        description="Destination under workspace/ (default: uploads).",
    ),
    file: UploadFile = File(...),
    auth: dict = Depends(require_auth),
):
    """Upload a user file INTO the agent's workspace.

    Lands under ``<storage>/workspace/<subdir>/`` — the same directory the
    GAPT sandbox bind-mounts at ``/workspace`` and the agent's file tools work
    in, so the agent (and its sub-agents) can immediately Read/process the
    file. This is the missing half of the workspace story: SendUserFile
    already delivers agent→user via workspace/outputs; this is user→agent.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    import os as _os
    import re as _re
    from pathlib import Path as _P

    storage_path = _storage_root_live_or_dormant(session_id)
    root = _P(storage_path).resolve()
    ws = (root / "workspace").resolve()

    # Destination guard: subdir must stay inside workspace/.
    sub = (ws / (subdir or "uploads")).resolve()
    try:
        sub.relative_to(ws)
    except ValueError:
        raise HTTPException(status_code=403, detail="subdir escapes workspace")
    sub.mkdir(parents=True, exist_ok=True)
    await _enforce_workspace_quota(str(root), 0)

    # Filename: keep the user's name, defanged (no separators/controls).
    raw_name = _os.path.basename(file.filename or "upload.bin")
    name = _re.sub(r"[^\w.\-\uAC00-\uD7A3\u3131-\u318E ()\[\]]", "_", raw_name).strip() or "upload.bin"
    dest = sub / name
    # No silent overwrite: suffix duplicates.
    if dest.exists():
        stem, dot, ext = name.partition(".")
        for i in range(1, 1000):
            cand = sub / (f"{stem}({i}){dot}{ext}" if dot else f"{stem}({i})")
            if not cand.exists():
                dest = cand
                break

    # Atomic: stage in .geny-sync-tmp then os.replace — a half-written
    # file must never be visible at its final name (the agent's GAPT
    # bind and sync replicas would pick up the partial bytes).
    import uuid as _uuid

    max_bytes = _workspace_max_file_bytes()
    tmp_dir = root / ".geny-sync-tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / f"upload-{_uuid.uuid4().hex}"
    size = 0
    try:
        with tmp.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"file exceeds {max_bytes // (1024*1024)} MiB",
                    )
                out.write(chunk)
        _os.replace(tmp, dest)
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="upload write failed")

    rel = str(dest.relative_to(root))
    await _sync_touch(session_id, str(root))
    return {
        "ok": True,
        "session_id": session_id,
        "path": rel,
        "workspace_path": str(dest.relative_to(ws)),
        "size": size,
    }


@router.get("/{session_id}/storage/changes")
async def storage_changes(
    session_id: str = Path(..., description="Session ID"),
    since: int = Query(0, ge=0, description="Cursor: last seq this replica applied (0 = bootstrap snapshot)"),
    auth: dict = Depends(require_auth),
):
    """Sync read model: workspace changes after ``since``.

    ``since=0`` returns every live entry (fresh replica bootstrap);
    ``since>0`` returns adds/updates/tombstones with ``seq > since``.
    A throttled incremental rescan runs first so agent-driven writes are
    included without any executor hook.
    """
    _enforce_session_owner(session_id, auth)
    from service.utils import workspace_sync

    storage_path = _storage_root_live_or_dormant(session_id)
    await asyncio.to_thread(workspace_sync.refresh_index, storage_path, session_id)
    result = await asyncio.to_thread(workspace_sync.changes_since, storage_path, since)
    result["max_file_bytes"] = _workspace_max_file_bytes()
    result["quota_bytes"] = workspace_sync.quota_bytes()
    result["used_bytes"] = await asyncio.to_thread(workspace_sync.used_bytes, storage_path)
    return result


async def _enforce_workspace_quota(storage_path: str, incoming: int) -> None:
    """507 when the workspace total would exceed the quota (0 disables)."""
    from service.utils import workspace_sync as _wsync

    quota = _wsync.quota_bytes()
    if quota <= 0:
        return
    used = await asyncio.to_thread(_wsync.used_bytes, storage_path)
    if used + max(0, incoming) > quota:
        raise HTTPException(
            status_code=507,
            detail={
                "error": "workspace quota exceeded",
                "quota_bytes": quota,
                "used_bytes": used,
            },
        )


@router.put("/{session_id}/storage/file")
async def put_workspace_file(
    request: Request,
    session_id: str = Path(..., description="Session ID"),
    path: str = Query(..., description="Exact destination (storage-root relative, under workspace/)"),
    base_sha: str = Query(
        "",
        description="sha256 the replica believes the server currently has. "
        "'' = replica thinks the file is new. Mismatch → 409 with the "
        "server's current sha (conflict signal — resolve client-side).",
    ),
    device: str = Query("", description="Replica device id (telemetry only)"),
    auth: dict = Depends(require_auth),
):
    """Sync write model: put raw bytes at an EXACT workspace path.

    Unlike /storage/upload (browser multipart, name-defanged, no-clobber
    suffixing) this is the replication primitive: the path is honoured
    verbatim, writes are atomic (temp file → os.replace), and optimistic
    concurrency runs on ``base_sha`` so two PCs can't silently clobber
    each other.
    """
    import os as _os
    import uuid as _uuid

    _enforce_session_owner(session_id, auth)
    from service.utils import workspace_sync

    root, ws, target = _workspace_target(session_id, path)
    if target == ws:
        raise HTTPException(status_code=403, detail="path must name a file")

    # Optimistic concurrency: compare against what's on disk right now.
    if target.exists():
        if target.is_dir():
            raise HTTPException(status_code=409, detail={"conflict": "is_dir"})
        cur = await asyncio.to_thread(workspace_sync.hash_file, target)
        if cur != base_sha:
            raise HTTPException(
                status_code=409,
                detail={"conflict": "modified", "current_sha": cur},
            )
    elif base_sha:
        # Replica thinks it's updating, but the file is gone server-side
        # (edit-vs-delete). Edit wins: accept the write (resurrect).
        pass

    # Quota: use Content-Length when the client sends one; the streaming
    # cap below still enforces the hard per-file limit either way.
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    await _enforce_workspace_quota(str(root), declared)

    max_bytes = _workspace_max_file_bytes()
    tmp_dir = root / ".geny-sync-tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / f"put-{_uuid.uuid4().hex}"

    import hashlib as _hashlib

    h = _hashlib.sha256()
    size = 0
    try:
        with tmp.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"file exceeds {max_bytes // (1024*1024)} MiB",
                    )
                h.update(chunk)
                out.write(chunk)
        # Final re-verify + replace under the storage lock: the pre-check
        # above is stale after seconds of streaming — two PCs racing the
        # same path must produce a 409 (conflict flow), never a silent
        # last-writer-wins.
        clash = await asyncio.to_thread(
            workspace_sync.commit_file, str(root), tmp, target, base_sha
        )
        if clash == "__is_dir__":
            raise HTTPException(status_code=409, detail={"conflict": "is_dir"})
        if clash is not None:
            raise HTTPException(
                status_code=409,
                detail={"conflict": "modified", "current_sha": clash},
            )
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="write failed")

    latest = await _sync_touch(session_id, str(root))
    return {
        "ok": True,
        "path": str(target.relative_to(root)),
        "sha256": h.hexdigest(),
        "size": size,
        "latest_seq": latest,
    }


# ── chunked / resumable upload (files above the connector's single-PUT
#    threshold). Sequential parts into .geny-sync-tmp/chunks/<id>.part,
#    then an atomic commit with the same base_sha conflict dance. ──────


@router.post("/{session_id}/storage/file/chunks/start")
async def chunk_upload_start(
    session_id: str = Path(..., description="Session ID"),
    path: str = Query(..., description="Final destination (storage-root relative, under workspace/)"),
    size: int = Query(..., ge=1, description="Total file size in bytes"),
    sha256: str = Query(..., min_length=64, max_length=64, description="sha256 of the full file"),
    auth: dict = Depends(require_auth),
):
    import json as _json
    import uuid as _uuid

    _enforce_session_owner(session_id, auth)
    from service.utils import workspace_sync

    root, ws, target = _workspace_target(session_id, path)
    if target == ws:
        raise HTTPException(status_code=403, detail="path must name a file")
    if size > _workspace_max_file_bytes():
        raise HTTPException(
            status_code=413,
            detail=f"file exceeds {_workspace_max_file_bytes() // (1024*1024)} MiB",
        )
    await _enforce_workspace_quota(str(root), size)

    cdir = workspace_sync.chunk_dir(str(root))
    cdir.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(workspace_sync.gc_stale_uploads, str(root))

    upload_id = _uuid.uuid4().hex
    (cdir / f"{upload_id}.part").touch()
    (cdir / f"{upload_id}.meta").write_text(
        _json.dumps({"path": path, "size": size, "sha256": sha256}),
        encoding="utf-8",
    )
    return {"upload_id": upload_id, "received": 0}


def _chunk_paths(session_id: str, upload_id: str):
    from pathlib import Path as _P

    from service.utils import workspace_sync

    if not workspace_sync.valid_upload_id(upload_id):
        raise HTTPException(status_code=400, detail="bad upload id")
    root = _P(_storage_root_live_or_dormant(session_id)).resolve()
    cdir = workspace_sync.chunk_dir(str(root))
    part = cdir / f"{upload_id}.part"
    meta = cdir / f"{upload_id}.meta"
    if not meta.exists():
        raise HTTPException(status_code=404, detail="unknown upload (expired?)")
    return root, part, meta


@router.get("/{session_id}/storage/file/chunks/{upload_id}")
async def chunk_upload_state(
    session_id: str = Path(...),
    upload_id: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Resume point: how many bytes the server already holds."""
    _enforce_session_owner(session_id, auth)
    _root, part, _meta = _chunk_paths(session_id, upload_id)
    return {"received": part.stat().st_size if part.exists() else 0}


@router.put("/{session_id}/storage/file/chunks/{upload_id}")
async def chunk_upload_part(
    request: Request,
    session_id: str = Path(...),
    upload_id: str = Path(...),
    offset: int = Query(..., ge=0, description="Byte offset — must equal bytes already received (sequential)"),
    auth: dict = Depends(require_auth),
):
    import json as _json

    _enforce_session_owner(session_id, auth)
    _root, part, meta = _chunk_paths(session_id, upload_id)
    info = _json.loads(meta.read_text(encoding="utf-8"))
    received = part.stat().st_size if part.exists() else 0
    if offset != received:
        # Out-of-order / duplicate part → tell the client where to resume.
        raise HTTPException(status_code=409, detail={"received": received})

    total = int(info["size"])
    written = 0
    with part.open("ab") as out:
        async for chunk in request.stream():
            written += len(chunk)
            if received + written > total:
                raise HTTPException(status_code=413, detail="exceeds declared size")
            out.write(chunk)
    return {"received": received + written}


@router.post("/{session_id}/storage/file/chunks/{upload_id}/commit")
async def chunk_upload_commit(
    session_id: str = Path(...),
    upload_id: str = Path(...),
    base_sha: str = Query("", description="Same conflict contract as PUT /storage/file"),
    auth: dict = Depends(require_auth),
):
    import json as _json
    import os as _os

    _enforce_session_owner(session_id, auth)
    from service.utils import workspace_sync

    root, part, meta = _chunk_paths(session_id, upload_id)
    info = _json.loads(meta.read_text(encoding="utf-8"))

    received = part.stat().st_size if part.exists() else 0
    if received != int(info["size"]):
        raise HTTPException(
            status_code=409, detail={"received": received, "expected": int(info["size"])}
        )
    actual_sha = await asyncio.to_thread(workspace_sync.hash_file, part)
    if actual_sha != info["sha256"]:
        part.unlink(missing_ok=True)
        meta.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="content hash mismatch — restart upload")

    _root2, ws, target = _workspace_target(session_id, info["path"])
    # Quota re-check at commit: the start-time check can be stale after
    # other uploads landed in between.
    if not target.exists():
        await _enforce_workspace_quota(str(root), received)
    # Atomic verify+replace under the storage lock (same anti-race
    # contract as PUT). On conflict the staged part is dropped — the
    # replica re-uploads after resolving.
    clash = await asyncio.to_thread(
        workspace_sync.commit_file, str(root), part, target, base_sha
    )
    if clash == "__is_dir__":
        meta.unlink(missing_ok=True)
        raise HTTPException(status_code=409, detail={"conflict": "is_dir"})
    if clash is not None:
        meta.unlink(missing_ok=True)
        raise HTTPException(
            status_code=409, detail={"conflict": "modified", "current_sha": clash}
        )
    meta.unlink(missing_ok=True)

    latest = await _sync_touch(session_id, str(root))
    return {
        "ok": True,
        "path": str(target.relative_to(root)),
        "sha256": actual_sha,
        "size": received,
        "latest_seq": latest,
    }


@router.get("/{session_id}/storage/sync-devices")
async def storage_sync_devices(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Replicas currently attached to this workspace (web UI chip)."""
    _enforce_session_owner(session_id, auth)
    from ws.workspace_stream import get_workspace_hub

    return {"devices": get_workspace_hub().devices(session_id)}


@router.get("/{session_id}/storage-raw/{file_path:path}")
async def download_storage_file_raw(
    session_id: str = Path(..., description="Session ID"),
    file_path: str = Path(..., description="File path relative to session storage"),
    auth: dict = Depends(require_auth),
):
    """Serve a session-storage file as raw bytes (binary download / inline view).

    The chat attachment renderer points ``<img src>`` / ``<a href>`` here for
    files the agent delivered via SendUserFile (workspace-canvas P1) — auth
    rides on the ``geny_auth_token`` cookie same-origin. Unlike the JSON
    ``/storage/{path}`` reader this streams bytes with the real content type.
    Works for dormant sessions too (storage_path from the session store), so
    links keep working after a backend restart.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    import mimetypes as _mimetypes
    from pathlib import Path as _FilePath

    from starlette.responses import FileResponse

    storage_path = _storage_root_live_or_dormant(session_id)
    root = _FilePath(storage_path).resolve()
    target = (root / file_path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Path escapes session storage")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    media_type = _mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(target, media_type=media_type, filename=target.name)


# ── On-demand Canvas document preview (edit2docs, no agent / no LibreOffice) ──

_DOC_PREVIEW_EXTS = {".pptx", ".docx", ".xlsx", ".pdf"}
_DOC_PREVIEW_SEM = asyncio.Semaphore(2)  # bound concurrent CPU-bound renders


def _doc_page_num(p) -> int:
    import re as _re

    m = _re.search(r"(\d+)", p.stem)
    return int(m.group(1)) if m else 0


def _render_doc_preview(src, ext: str, cache_dir):
    """Render *src* into *cache_dir* → (kind, [page paths]). Runs in a thread."""
    import edit2docs

    if ext == ".pptx":
        edit2docs.preview_doc(str(src), out_dir=str(cache_dir))  # slide_NNN.svg
        pages = sorted(cache_dir.glob("slide_*.svg"))
        return ("svg", pages)
    if ext in (".docx", ".xlsx"):
        edit2docs.render_doc(str(src), to="png", out_dir=str(cache_dir), dpi=120)
        pages = sorted(cache_dir.glob("page-*.png"), key=_doc_page_num)
        return ("png", pages)
    if ext == ".pdf":
        from tools.built_in.document_tools import _pdf_to_pngs

        pages = _pdf_to_pngs(src, cache_dir)
        return ("png", pages)
    raise ValueError(f"unsupported preview ext {ext}")


@router.get("/{session_id}/doc-preview")
async def get_doc_preview(
    session_id: str = Path(..., description="Session ID"),
    path: str = Query(..., description="File path relative to session storage"),
    auth: dict = Depends(require_auth),
):
    """On-demand Canvas preview — render an office/pdf file to per-slide SVGs
    (pptx, via ``edit2docs.preview_doc``) or page PNGs (docx/xlsx via
    ``edit2docs.render_doc``; pdf via pdftoppm). No agent turn and — for the
    modern office formats — no LibreOffice. The result is cached under
    ``.canvas-preview/<key>/<mtime>/`` keyed on the source's mtime, so
    re-selecting a file is instant and an edited doc re-renders automatically.
    Returns page paths (relative to storage) that the client loads through the
    ``storage-raw`` endpoint. Works for dormant sessions too."""
    _enforce_session_owner(session_id, auth)  # audit S6
    import hashlib
    import shutil
    from pathlib import Path as _FilePath

    storage_path = _storage_root_live_or_dormant(session_id)
    root = _FilePath(storage_path).resolve()
    src = (root / path).resolve()
    try:
        src.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Path escapes session storage")
    if not src.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    ext = src.suffix.lower()
    if ext not in _DOC_PREVIEW_EXTS:
        return {"kind": "unsupported", "count": 0, "pages": []}

    mtime = int(src.stat().st_mtime)
    key = hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]
    rel_base = f".canvas-preview/{key}/{mtime}"
    cache_dir = root / ".canvas-preview" / key / str(mtime)

    def _cached_pages():
        if not cache_dir.is_dir():
            return None
        svgs = sorted(cache_dir.glob("slide_*.svg"))
        if svgs:
            return ("svg", svgs)
        pngs = sorted(cache_dir.glob("page-*.png"), key=_doc_page_num)
        if pngs:
            return ("png", pngs)
        return None

    result = _cached_pages()
    if result is None:
        # Prune stale mtime dirs for this file so the cache doesn't grow forever.
        try:
            parent = cache_dir.parent
            if parent.is_dir():
                for old in parent.iterdir():
                    if old.is_dir() and old.name != str(mtime):
                        shutil.rmtree(old, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        cache_dir.mkdir(parents=True, exist_ok=True)
        async with _DOC_PREVIEW_SEM:
            result = _cached_pages()  # another request may have rendered it
            if result is None:
                try:
                    result = await asyncio.to_thread(
                        _render_doc_preview, src, ext, cache_dir
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "doc-preview render failed for %s: %s", path, e, exc_info=True
                    )
                    raise HTTPException(
                        status_code=422, detail=f"Preview render failed: {e}"
                    )

    kind, pages = result
    return {
        "kind": kind,
        "count": len(pages),
        "pages": [f"{rel_base}/{p.name}" for p in pages],
    }


@router.get("/{session_id}/storage/{file_path:path}")
async def read_storage_file(
    session_id: str = Path(..., description="Session ID"),
    file_path: str = Path(..., description="File path"),
    encoding: str = Query("utf-8", description="File encoding"),
    auth: dict = Depends(require_auth),
):
    """
    Read storage file content. Works for dormant sessions too.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    from service.utils import file_storage as storage_utils

    storage_path = _storage_root_live_or_dormant(session_id)

    file_content = storage_utils.read_storage_file(
        storage_path, file_path, encoding=encoding, session_id=session_id
    )
    if not file_content:
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    return StorageFileContent(
        session_id=session_id,
        **file_content
    )


@router.get("/{session_id}/download-folder")
async def download_storage_folder(
    session_id: str = Path(..., description="Session ID"),
    path: str = Query("", description="Optional subfolder (storage-root relative) to zip instead of the whole storage"),
    auth: dict = Depends(require_auth),
):
    """
    Download the session's storage folder as a ZIP archive.

    Streams the ZIP file directly so the browser triggers a download.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    import os
    import io
    import zipfile
    from fastapi.responses import StreamingResponse

    # Resolve storage path — live agent first, then session store
    agent = agent_manager.get_agent(session_id)
    if agent and agent.storage_path:
        folder = agent.storage_path
    else:
        store = get_session_store()
        session_data = store.get(session_id)
        if session_data and session_data.get("storage_path"):
            folder = session_data["storage_path"]
        else:
            raise HTTPException(
                status_code=404,
                detail=f"Session not found or no storage path: {session_id}",
            )

    if path:
        from pathlib import Path as _P

        sub = (_P(folder) / path).resolve()
        try:
            sub.relative_to(_P(folder).resolve())
        except ValueError:
            raise HTTPException(status_code=403, detail="Path escapes session storage")
        folder = str(sub)

    if not os.path.isdir(folder):
        raise HTTPException(
            status_code=404, detail=f"Folder does not exist: {folder}"
        )

    # Build ZIP in memory
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(folder):
            for fname in files:
                abs_path = os.path.join(root, fname)
                arc_name = os.path.relpath(abs_path, folder)
                try:
                    zf.write(abs_path, arc_name)
                except (PermissionError, OSError):
                    pass  # skip unreadable files
    buf.seek(0)

    zip_filename = f"session-{session_id[:8]}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{zip_filename}"'
        },
    )


# ============================================================================
# Graph Introspection API
# ============================================================================


class GraphNodeInfo(BaseModel):
    """Single node/state in the graph."""
    id: str
    label: str
    type: str = "node"  # node | start | end
    description: str = ""
    prompt_template: Optional[str] = None
    metadata: dict = {}


class GraphEdgeInfo(BaseModel):
    """Single edge in the graph."""
    source: str
    target: str
    label: str = ""
    type: str = "edge"  # edge | conditional
    condition_map: Optional[dict] = None


class GraphStructure(BaseModel):
    """Complete graph topology for visualization."""
    session_id: str
    session_name: str = ""
    graph_type: str = "simple"  # simple | autonomous
    nodes: list[GraphNodeInfo] = []
    edges: list[GraphEdgeInfo] = []



@router.get("/{session_id}/graph")
async def get_session_graph(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Get pipeline info for a session (replaces workflow graph)."""
    agent: Optional[AgentSession] = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    wid = getattr(agent, '_workflow_id', '') or ''
    preset = 'vtuber' if 'vtuber' in wid else 'worker_adaptive'

    return {
        "session_id": session_id,
        "preset": preset,
        "workflow_id": wid,
        "execution_backend": "pipeline",
    }


@router.get("/{session_id}/workflow")
async def get_session_workflow(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Get pipeline preset info (replaces workflow definition)."""
    agent: Optional[AgentSession] = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    wid = getattr(agent, '_workflow_id', '') or ''
    preset = 'vtuber' if 'vtuber' in wid else 'worker_adaptive'

    return {
        "id": wid or f"preset-{preset}",
        "name": preset,
        "preset": preset,
        "execution_backend": "pipeline",
    }


# ============================================================================
# G2.5 — HITL endpoints (Stage 15 / Pipeline.resume API)
# ============================================================================
#
# An external decision channel (typically the frontend HITL modal,
# reached over /api/agents) satisfies pending HITL requests by posting
# the operator's decision to /api/agents/{session_id}/hitl/resume.
# The endpoint dispatches to ``Pipeline.resume(token, decision)``,
# which resolves the asyncio.Future the HITLStage's
# PipelineResumeRequester is awaiting on.


class HITLResumeRequest(BaseModel):
    token: str = Field(..., description="HITL request token issued by the pipeline")
    decision: str = Field(..., description="approve | reject | cancel")


class HITLPendingItem(BaseModel):
    token: str


class HITLPendingResponse(BaseModel):
    session_id: str
    pending: List[HITLPendingItem]


def _resolve_pipeline(session_id: str):
    agent: Optional[AgentSession] = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    pipeline = getattr(agent, "_pipeline", None)
    if pipeline is None:
        raise HTTPException(
            status_code=409,
            detail=f"Session {session_id} has no built pipeline yet",
        )
    return pipeline


@router.get(
    "/{session_id}/hitl/pending",
    response_model=HITLPendingResponse,
    summary="List pending HITL request tokens",
)
async def list_pending_hitl(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Returns the tokens of unresolved HITL requests this session is
    awaiting. Drives the frontend HITL modal's "approval needed"
    indicator without forcing it to subscribe to the WebSocket
    event stream just to discover what's outstanding."""
    pipeline = _resolve_pipeline(session_id)
    list_pending = getattr(pipeline, "list_pending_hitl", None)
    if not callable(list_pending):
        # Pipelines built before geny-executor 1.0 / S9c.1 don't have
        # the resume API. Treat as "no pending" rather than 500 so
        # mixed-version deployments degrade gracefully.
        return HITLPendingResponse(session_id=session_id, pending=[])
    tokens: List[str] = list_pending() or []
    return HITLPendingResponse(
        session_id=session_id,
        pending=[HITLPendingItem(token=t) for t in tokens],
    )


@router.post(
    "/{session_id}/hitl/resume",
    summary="Resolve a pending HITL request",
)
async def resume_hitl(
    body: HITLResumeRequest,
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Resolve a pending HITL request by token + decision. Calls
    :meth:`Pipeline.resume(token, decision)` which sets the future
    the HITL stage's :class:`PipelineResumeRequester` is awaiting on,
    so the loop continues from where it paused.

    Returns 404 when the session is unknown, 409 when the pipeline
    has no resume API or the token is unknown / already resolved,
    400 when the decision string is unrecognised.
    """
    pipeline = _resolve_pipeline(session_id)
    resume = getattr(pipeline, "resume", None)
    if not callable(resume):
        raise HTTPException(
            status_code=409,
            detail="pipeline has no resume() — geny-executor < 1.0 in use",
        )
    try:
        resume(body.token, body.decision)
    except KeyError:
        raise HTTPException(status_code=409, detail=f"unknown HITL token: {body.token}")
    except RuntimeError as exc:  # already resolved
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:  # unknown decision
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "session_id": session_id,
        "token": body.token,
        "decision": body.decision,
        "resumed": True,
    }


@router.delete(
    "/{session_id}/hitl/{token}",
    summary="Cancel a pending HITL request",
)
async def cancel_hitl(
    session_id: str = Path(..., description="Session ID"),
    token: str = Path(..., description="HITL request token"),
    auth: dict = Depends(require_auth),
):
    """Cancel a pending HITL request. Equivalent to ``resume`` with
    decision ``cancel`` but a separate verb for "session terminated,
    drop in-flight approvals" cleanup paths.

    Returns 404 when the session is unknown, 409 when the pipeline
    has no resume API, and ``cancelled=False`` (with 200) when the
    token is unknown or already resolved.
    """
    pipeline = _resolve_pipeline(session_id)
    cancel = getattr(pipeline, "cancel_pending_hitl", None)
    if not callable(cancel):
        raise HTTPException(
            status_code=409,
            detail="pipeline has no cancel_pending_hitl() — geny-executor < 1.0",
        )
    cancelled = bool(cancel(token))
    return {"session_id": session_id, "token": token, "cancelled": cancelled}


# ============================================================================
# G7.1 — Checkpoint listing + restore (Stage 20 / restore_state_from_checkpoint)
# ============================================================================
#
# Stage 20 (Persist) writes checkpoint snapshots to disk via the
# session-scoped FilePersister installed by service.persist.install.
# These endpoints expose the read side: list available checkpoint ids
# and trigger a restore. The actual state rebuild happens inside the
# executor's ``restore_state_from_checkpoint`` helper (S9c.2). The
# endpoint here resolves the session's storage_path and dispatches.


class CheckpointInfo(BaseModel):
    checkpoint_id: str = Field(..., description="Stable id (filename stem)")
    written_at: float = Field(..., description="Unix mtime of the checkpoint file")
    size_bytes: int = Field(..., description="On-disk size")


class CheckpointListResponse(BaseModel):
    session_id: str
    checkpoints: List[CheckpointInfo]


class CheckpointRestoreRequest(BaseModel):
    checkpoint_id: str = Field(..., description="Checkpoint id from /checkpoints list")


def _resolve_storage_path(session_id: str) -> str:
    agent: Optional[AgentSession] = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    storage_path = getattr(agent, "storage_path", None)
    if not storage_path:
        raise HTTPException(
            status_code=409,
            detail=f"Session {session_id} has no storage_path — checkpoints unavailable",
        )
    return str(storage_path)


@router.get(
    "/{session_id}/checkpoints",
    response_model=CheckpointListResponse,
    summary="List crash-recovery checkpoints for a session",
)
async def list_checkpoints_endpoint(
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Enumerate the checkpoints Stage 20 has written for *session_id*.

    Returns ``[]`` when the session has never written a checkpoint
    (the vtuber preset keeps persist off by default, so this is the
    expected response there).
    """
    storage_path = _resolve_storage_path(session_id)
    from service.persist.restore import list_checkpoints

    items = [CheckpointInfo(**c) for c in list_checkpoints(storage_path)]
    return CheckpointListResponse(session_id=session_id, checkpoints=items)


@router.post(
    "/{session_id}/checkpoints/restore",
    summary="Restore the agent's pipeline state from a checkpoint",
)
async def restore_checkpoint_endpoint(
    body: CheckpointRestoreRequest,
    session_id: str = Path(..., description="Session ID"),
    auth: dict = Depends(require_auth),
):
    """Rebuild a :class:`PipelineState` from the given checkpoint id
    and bind it onto the session's active pipeline.

    Runtime fields (``llm_client`` / ``session_runtime``) are
    intentionally *not* restored — they're rebound by the next pipeline
    run. This matches the executor's ``restore_state_from_checkpoint``
    contract.

    Returns 404 when the session is unknown, 409 when the session has
    no storage_path or the executor pin is too old, and 410 when the
    checkpoint id doesn't exist.
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    storage_path = _resolve_storage_path(session_id)
    agent: Optional[AgentSession] = agent_manager.get_agent(session_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    from service.persist.restore import (
        CheckpointNotFoundError,
        restore_checkpoint,
    )

    try:
        state = await restore_checkpoint(storage_path, body.checkpoint_id)
    except ImportError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except CheckpointNotFoundError:
        raise HTTPException(
            status_code=410,
            detail=f"Checkpoint not found: {body.checkpoint_id}",
        )

    # Apply the restored state to the session's pipeline. The pipeline
    # carries the runtime objects; we only swap the message / tasks /
    # memory_refs / turn_summary / etc. fields the persister captured.
    pipeline = getattr(agent, "_pipeline", None)
    if pipeline is None:
        raise HTTPException(
            status_code=409,
            detail=f"Session {session_id} has no built pipeline yet",
        )
    # Pipeline owns its state; assign on the next run via the standard
    # entry point. We expose the restored fields on the agent so the
    # next execute_command can pick them up. Each agent surface has
    # its own conventions; for now we surface the restored state
    # on the agent so the caller can inspect via /state.
    setattr(agent, "_restored_state", state)

    return {
        "session_id": session_id,
        "checkpoint_id": body.checkpoint_id,
        "restored": True,
        "messages_restored": len(getattr(state, "messages", []) or []),
    }


# ============================================================================
# G8.1 — Per-session MCP admin (Phase 6 MCPManager.connect / disconnect FSM)
# ============================================================================
#
# The executor's MCPManager lives on each pipeline (Pipeline._mcp_manager).
# These endpoints expose its public API so an operator can add /
# disable / enable / disconnect MCP servers on a *running* session
# without restarting the process. State changes flow back over the
# WebSocket as `mcp_server_state` events (G8.2 wires the bridge).


class MCPServerStateInfo(BaseModel):
    name: str
    state: str
    last_error: Optional[str] = None


class MCPServerListResponse(BaseModel):
    session_id: str
    servers: List[MCPServerStateInfo]


class MCPServerAddRequest(BaseModel):
    name: str = Field(..., description="Unique server name")
    config: Dict[str, Any] = Field(
        ..., description="Transport-specific config dict (command, url, env, etc.)"
    )


def _resolve_mcp_manager(session_id: str):
    pipeline = _resolve_pipeline(session_id)
    manager = getattr(pipeline, "_mcp_manager", None) or getattr(
        pipeline, "mcp_manager", None
    )
    if manager is None:
        raise HTTPException(
            status_code=409,
            detail=f"Session {session_id} pipeline has no MCPManager attached",
        )
    return manager


def _serialize_server(name: str, manager: Any) -> MCPServerStateInfo:
    """Best-effort: read state from MCPManager. The exact API varies by
    executor minor version (`get_state` / `state_of` / `_states[name]`),
    so try a couple of shapes before falling back to ``unknown``."""
    state = "unknown"
    last_error: Optional[str] = None
    for attr in ("get_state", "state_of"):
        getter = getattr(manager, attr, None)
        if callable(getter):
            try:
                value = getter(name)
                state = getattr(value, "value", str(value))
                break
            except Exception:
                continue
    states_dict = getattr(manager, "_states", None) or getattr(manager, "states", None)
    if state == "unknown" and isinstance(states_dict, dict) and name in states_dict:
        value = states_dict[name]
        state = getattr(value, "value", str(value))
    errors = getattr(manager, "_errors", None) or getattr(manager, "errors", None)
    if isinstance(errors, dict):
        err = errors.get(name)
        if err:
            last_error = str(err)
    return MCPServerStateInfo(name=name, state=state, last_error=last_error)


@router.get(
    "/{session_id}/mcp/servers",
    response_model=MCPServerListResponse,
    summary="List MCP servers attached to a session",
)
async def list_mcp_servers(
    session_id: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Return the MCPManager's current view of every server it knows
    about, including FSM state."""
    manager = _resolve_mcp_manager(session_id)
    names = []
    for attr in ("server_names", "list_servers"):
        getter = getattr(manager, attr, None)
        if callable(getter):
            try:
                names = list(getter())
                break
            except Exception:
                continue
        if isinstance(getter, (list, tuple, set)):
            names = list(getter)
            break
    if not names:
        configs = getattr(manager, "_configs", None) or getattr(manager, "configs", None)
        if isinstance(configs, dict):
            names = list(configs.keys())
    return MCPServerListResponse(
        session_id=session_id,
        servers=[_serialize_server(n, manager) for n in names],
    )


@router.post(
    "/{session_id}/mcp/servers",
    summary="Connect a new MCP server on a running session",
)
async def add_mcp_server(
    body: MCPServerAddRequest,
    session_id: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Dispatches to ``MCPManager.connect(name, config)``.

    Returns 409 when the executor pin doesn't expose the ``connect``
    method or the server name is already owned by the manifest
    (G8.4: manifest-declared servers win over runtime add — they
    survive session restarts and are auditable in git, so we refuse
    runtime mutation rather than silently shadowing them).
    """
    _enforce_session_owner(session_id, auth)  # audit S6
    manager = _resolve_mcp_manager(session_id)
    connect = getattr(manager, "connect", None)
    if not callable(connect):
        raise HTTPException(
            status_code=409,
            detail="MCPManager has no connect() — geny-executor < 1.0",
        )

    # G8.4: collision policy. Manifest server names live in
    # ``_manifest_server_names`` (a frozen set the install layer
    # populates from manifest.tools.mcp_servers) — when present, we
    # refuse a runtime add for the same name so the operator picks
    # an unambiguous slot. Falls open when the attribute doesn't
    # exist (older executor pin).
    manifest_owned = getattr(manager, "_manifest_server_names", None)
    if manifest_owned is None:
        # Best-effort: peek at configs that were registered before
        # any runtime add happened.
        configs = getattr(manager, "_configs", None) or getattr(manager, "configs", None)
        manifest_owned = set(configs.keys()) if isinstance(configs, dict) else set()
    if body.name in manifest_owned:
        logger.warning(
            "[%s] runtime MCP add for %r conflicts with manifest server; refused",
            session_id, body.name,
        )
        raise HTTPException(
            status_code=409,
            detail=(
                f"server name '{body.name}' is already declared in the "
                "session manifest. Manifest servers are immutable at "
                "runtime — pick a different name or update the manifest "
                "and restart the session."
            ),
        )

    try:
        result = connect(body.name, body.config)
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"connect failed: {exc}")
    return {
        "session_id": session_id,
        "server": _serialize_server(body.name, manager).model_dump(),
    }


@router.delete(
    "/{session_id}/mcp/servers/{name}",
    summary="Disconnect an MCP server from a running session",
)
async def disconnect_mcp_server(
    session_id: str = Path(...),
    name: str = Path(...),
    auth: dict = Depends(require_auth),
):
    manager = _resolve_mcp_manager(session_id)
    disc = getattr(manager, "disconnect", None)
    if not callable(disc):
        raise HTTPException(status_code=409, detail="MCPManager has no disconnect()")
    try:
        result = disc(name)
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"disconnect failed: {exc}")
    return {"session_id": session_id, "name": name, "disconnected": True}


@router.post(
    "/{session_id}/mcp/servers/{name}/{action}",
    summary="Disable / enable / test an MCP server",
)
async def control_mcp_server(
    session_id: str = Path(...),
    name: str = Path(...),
    action: str = Path(..., description="One of: disable / enable / test"),
    auth: dict = Depends(require_auth),
):
    if action not in ("disable", "enable", "test"):
        raise HTTPException(status_code=400, detail=f"Unknown action: {action}")
    manager = _resolve_mcp_manager(session_id)
    method_name = {
        "disable": "disable_server",
        "enable": "enable_server",
        "test": "test_connection",
    }[action]
    fn = getattr(manager, method_name, None)
    if not callable(fn):
        raise HTTPException(
            status_code=409,
            detail=f"MCPManager has no {method_name}() — geny-executor < 1.0",
        )
    try:
        result = fn(name)
        if hasattr(result, "__await__"):
            result = await result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"{action} failed: {exc}")
    return {
        "session_id": session_id,
        "name": name,
        "action": action,
        "result": str(result) if result is not None else "ok",
        "server": _serialize_server(name, manager).model_dump(),
    }


# ============================================================================
# G15 — Pipeline introspection (Dashboard heatmap source)
# ============================================================================
#
# Wraps geny_executor.core.introspection.introspect_all so the frontend
# Dashboard can render a per-stage strategy heatmap (green = override
# applied, red = default, grey = no slot of that name).


class StageIntrospectInfo(BaseModel):
    order: int
    name: str
    artifact: str
    strategy_slots: Dict[str, Any]
    strategy_chains: Dict[str, Any]


class PipelineIntrospectResponse(BaseModel):
    session_id: str
    stages: List[StageIntrospectInfo]


@router.get(
    "/{session_id}/pipeline/introspect",
    response_model=PipelineIntrospectResponse,
    summary="Snapshot of every registered stage + active strategies",
)
async def introspect_pipeline(
    session_id: str = Path(...),
    auth: dict = Depends(require_auth),
):
    """Returns each stage's order / name / artifact id plus the
    currently-active strategy id per slot. Drives the Dashboard's
    StageStrategyHeatmap (G15).

    409 when the executor's introspection helper isn't importable.
    """
    pipeline = _resolve_pipeline(session_id)
    try:
        from geny_executor.core.introspection import introspect_all
    except ImportError:
        raise HTTPException(
            status_code=409,
            detail="geny_executor.core.introspection unavailable",
        )

    # introspect_all walks the global stage catalog by default; pass
    # the pipeline-specific override map when one is available so we
    # report the active artifact per slot.
    artifact_overrides: Dict[str, str] = {}
    for stage in pipeline.stages:
        artifact_overrides[stage.name] = getattr(stage, "artifact", "default") or "default"

    try:
        rows = introspect_all(artifact_overrides=artifact_overrides)
    except TypeError:
        # Older signature didn't accept the kwarg.
        rows = introspect_all()

    out: List[StageIntrospectInfo] = []
    for row in rows:
        out.append(
            StageIntrospectInfo(
                order=getattr(row, "order", 0),
                name=getattr(row, "name", ""),
                artifact=getattr(row, "artifact", "default"),
                strategy_slots={
                    name: {
                        "active": getattr(slot, "active_name", None) or getattr(slot, "active", None),
                        "registered": list(getattr(slot, "registered_names", []) or []),
                    }
                    for name, slot in (getattr(row, "strategy_slots", {}) or {}).items()
                },
                strategy_chains={
                    name: {
                        "items": list(getattr(chain, "active_names", []) or []),
                        "registered": list(getattr(chain, "registered_names", []) or []),
                    }
                    for name, chain in (getattr(row, "strategy_chains", {}) or {}).items()
                },
            )
        )

    return PipelineIntrospectResponse(session_id=session_id, stages=out)
