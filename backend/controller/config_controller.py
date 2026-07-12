"""
Configuration Controller for Geny Agent.

Provides REST API endpoints for managing configurations:
- GET /api/config - List all configs
- GET /api/config/schemas - Get all config schemas
- GET /api/config/{name} - Get specific config
- PUT /api/config/{name} - Update config
- DELETE /api/config/{name} - Reset config to defaults
- POST /api/config/export - Export all configs
- POST /api/config/import - Import configs
"""

from logging import getLogger
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Body, Request
from pydantic import BaseModel

from service.auth.auth_middleware import require_auth
from service.config import ConfigManager, get_config_manager

logger = getLogger(__name__)

router = APIRouter(prefix="/api/config", tags=["config"])


# Pydantic models for API
class ConfigUpdateRequest(BaseModel):
    """Request body for updating a config"""
    values: Dict[str, Any]


class ConfigImportRequest(BaseModel):
    """Request body for importing configs"""
    configs: Dict[str, Dict[str, Any]]


class ConfigResponse(BaseModel):
    """Response for a single config"""
    name: str
    display_name: str
    description: str
    category: str
    icon: str
    values: Dict[str, Any]
    valid: bool
    errors: List[str]


class ConfigSchemaResponse(BaseModel):
    """Response for config schema"""
    name: str
    display_name: str
    description: str
    category: str
    icon: str
    fields: List[Dict[str, Any]]


class ConfigListResponse(BaseModel):
    """Response for listing all configs"""
    configs: List[Dict[str, Any]]
    categories: List[Dict[str, str]]


class ConfigSchemasResponse(BaseModel):
    """Response for all schemas"""
    schemas: List[Dict[str, Any]]


@router.get("", response_model=ConfigListResponse)
async def list_configs(auth: dict = Depends(require_auth)):
    """
    List all configurations with their current values.

    Returns configs grouped by category with validation status.
    Configs whose class returns ``is_user_visible() == False`` are
    excluded — they have a dedicated editor surface (e.g.
    ``llm_credentials`` via the LLM Backends panel) and must not
    leak into the generic auto-form list.

    Auth-gated + secret-masked (audit S1): this bulk listing must never
    return cleartext credentials, and previously required no auth at all.
    """
    manager = get_config_manager()

    config_classes = manager.get_registered_config_classes()
    all_configs = manager.get_all_configs()
    configs = [
        c for c in all_configs
        if config_classes.get(c.get("schema", {}).get("name", ""), None) is None
        or config_classes[c["schema"]["name"]].is_user_visible()
    ]

    # Extract unique categories
    categories_set = set()
    for config in configs:
        category = config.get("schema", {}).get("category", "general")
        categories_set.add(category)

    # Category metadata
    category_info = {
        "general": {"name": "general", "label": "General", "icon": "settings"},
        "tools": {"name": "tools", "label": "Tool", "icon": "wrench"},
        "channels": {"name": "channels", "label": "Channels", "icon": "chat"},
        "tts": {"name": "tts", "label": "TTS", "icon": "volume"},
        "security": {"name": "security", "label": "Security", "icon": "shield"},
        "advanced": {"name": "advanced", "label": "Advanced", "icon": "code"},
    }

    categories = [
        category_info.get(cat, {"name": cat, "label": cat.title(), "icon": "folder"})
        for cat in sorted(categories_set)
    ]

    return ConfigListResponse(configs=configs, categories=categories)


@router.get("/schemas", response_model=ConfigSchemasResponse)
async def get_schemas(auth: dict = Depends(require_auth)):
    """
    Get schemas for all registered configurations.

    Returns field definitions for building configuration forms.
    Auth-gated (audit S1) — schemas enumerate config names an attacker
    would otherwise use to target the value endpoints.
    """
    manager = get_config_manager()
    schemas = manager.get_all_schemas()

    return ConfigSchemasResponse(schemas=schemas)


@router.get("/{config_name}")
async def get_config(config_name: str, auth: dict = Depends(require_auth)):
    """
    Get a specific configuration by name.

    Args:
        config_name: The config identifier (e.g., 'discord', 'slack', 'teams')

    Returns:
        Config schema, values, and validation status.

    Auth-gated (audit S1): previously unauthenticated — this returned
    cleartext SSH passwords / API keys / bot tokens to any caller. Values
    are still returned in full to the authenticated admin so the editor's
    secret show/hide toggle keeps working.
    """
    manager = get_config_manager()
    config_classes = manager.get_registered_config_classes()

    if config_name not in config_classes:
        raise HTTPException(status_code=404, detail=f"Config '{config_name}' not found")

    config_class = config_classes[config_name]

    try:
        config = manager.load_config(config_class)

        return {
            "schema": config_class.get_schema(),
            "values": config.to_dict(),
            "valid": config.is_valid(),
            "errors": config.validate()
        }
    except Exception as e:
        logger.error(f"Failed to get config {config_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


_GATEWAY_CHANNEL_CONFIGS = {"telegram", "discord", "slack", "kakao", "teams"}
# Credential configs whose values are snapshotted into each session's
# CredentialBundle at build time — a change must rebuild live sessions to take
# effect (the LLM 백엔드 panel writes llm_credentials here). See
# AgentSessionManager.refresh_all_session_credentials.
_CREDENTIAL_CONFIGS = {"llm_credentials", "cli_backends", "media_credentials"}


@router.put("/{config_name}")
async def update_config(
    config_name: str,
    request: ConfigUpdateRequest,
    http_request: Request,
    auth: dict = Depends(require_auth),
):
    """
    Update a configuration.

    Args:
        config_name: The config identifier
        request: The new values to set

    Returns:
        Updated config with validation status.
    """
    manager = get_config_manager()
    config_classes = manager.get_registered_config_classes()

    if config_name not in config_classes:
        raise HTTPException(status_code=404, detail=f"Config '{config_name}' not found")

    try:
        # Drop any field left at the secret-mask sentinel (audit S1): a
        # client that round-trips the masked bulk-list value must not
        # overwrite the real stored secret with the placeholder string.
        from service.config.base import BaseConfig as _BaseConfig

        incoming = {
            k: v for k, v in (request.values or {}).items()
            if v != _BaseConfig.SECRET_MASK
        }
        updated_config = manager.update_config(config_name, incoming)

        if updated_config is None:
            raise HTTPException(status_code=500, detail="Failed to update config")

        # Hot-reload the inbound gateway when a channel integration changes, so
        # enabling Telegram/Discord/Slack in the UI takes effect immediately
        # (no backend restart). Best-effort — a reload failure never fails the
        # save.
        if config_name in _GATEWAY_CHANNEL_CONFIGS:
            try:
                from service.gateway import reload_gateway
                await reload_gateway(http_request.app.state)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"gateway reload after {config_name} save failed: {e}")

        # Rebuild live sessions when LLM backend credentials change, so the new
        # key reaches their (snapshotted) CredentialBundle — Stage-6 LLM AND the
        # embedding/vector-memory clients — without a manual restart. Best-effort.
        if config_name in _CREDENTIAL_CONFIGS:
            try:
                from service.executor.agent_session_manager import get_agent_session_manager
                await get_agent_session_manager().refresh_all_session_credentials()
            except Exception as e:  # noqa: BLE001
                logger.warning(f"credential refresh after {config_name} save failed: {e}")

        return {
            "success": True,
            "message": f"Config '{config_name}' updated successfully",
            "values": updated_config.to_dict(),
            "valid": updated_config.is_valid(),
            "errors": updated_config.validate()
        }
    except Exception as e:
        logger.error(f"Failed to update config {config_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{config_name}")
async def reset_config(config_name: str, auth: dict = Depends(require_auth)):
    """
    Reset a configuration to default values.

    Args:
        config_name: The config identifier

    Returns:
        Reset config with default values.
    """
    manager = get_config_manager()
    config_classes = manager.get_registered_config_classes()

    if config_name not in config_classes:
        raise HTTPException(status_code=404, detail=f"Config '{config_name}' not found")

    try:
        # Delete existing config file
        manager.delete_config(config_name)

        # Reload with defaults
        config_class = config_classes[config_name]
        config = manager.load_config(config_class)

        return {
            "success": True,
            "message": f"Config '{config_name}' reset to defaults",
            "values": config.to_dict()
        }
    except Exception as e:
        logger.error(f"Failed to reset config {config_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/export")
async def export_configs(auth: dict = Depends(require_auth)):
    """
    Export all configurations.

    Returns:
        Dictionary of all config values for backup.
    """
    manager = get_config_manager()

    try:
        data = manager.export_all_configs()

        return {
            "success": True,
            "configs": data
        }
    except Exception as e:
        logger.error(f"Failed to export configs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/import")
async def import_configs(request: ConfigImportRequest, auth: dict = Depends(require_auth)):
    """
    Import configurations from backup.

    Args:
        request: Dictionary of config data to import

    Returns:
        Import results for each config.
    """
    manager = get_config_manager()

    try:
        results = manager.import_configs(request.configs)

        success_count = sum(1 for v in results.values() if v)
        fail_count = sum(1 for v in results.values() if not v)

        return {
            "success": fail_count == 0,
            "message": f"Imported {success_count} configs, {fail_count} failed",
            "results": results
        }
    except Exception as e:
        logger.error(f"Failed to import configs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reload")
async def reload_configs(auth: dict = Depends(require_auth)):
    """
    Reload all configurations from files.

    Useful after manual file edits.
    """
    manager = get_config_manager()

    try:
        manager.reload_all_configs()

        return {
            "success": True,
            "message": "All configs reloaded"
        }
    except Exception as e:
        logger.error(f"Failed to reload configs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{config_name}/validate")
async def validate_config(config_name: str, auth: dict = Depends(require_auth)):
    """
    Validate a configuration without saving.

    Args:
        config_name: The config identifier

    Returns:
        Validation results.
    """
    manager = get_config_manager()
    config_classes = manager.get_registered_config_classes()

    if config_name not in config_classes:
        raise HTTPException(status_code=404, detail=f"Config '{config_name}' not found")

    try:
        config = manager.get_config(config_name)

        if config is None:
            raise HTTPException(status_code=404, detail="Config not found")

        errors = config.validate()

        return {
            "valid": len(errors) == 0,
            "errors": errors
        }
    except Exception as e:
        logger.error(f"Failed to validate config {config_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
