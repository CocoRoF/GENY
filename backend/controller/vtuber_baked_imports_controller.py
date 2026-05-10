"""
VTuber Baked Imports Controller

Read-only inbox for baked puppet zips that the avatar-editor service
drops into the shared docker volume (/data/baked-imports). The user
sees these as "ready to install" — actual install (unzip + register
in model_registry) lives in the matching install endpoint (Phase C.3).

Endpoints:
    GET    /api/vtuber/baked-imports/list
    DELETE /api/vtuber/baked-imports/{filename}

The volume is mounted read-only by docker-compose (`:ro`), so deletes
won't work in the running compose setup — but the operator can mount
read-write or run delete from the writer side. The endpoint exists so
the UI can offer "discard" without baking that into a separate ops
workflow; failure surfaces as a clear error string.
"""

import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from logging import getLogger

logger = getLogger(__name__)

router = APIRouter(prefix="/api/vtuber/baked-imports", tags=["vtuber"])

# Single source of truth for the inbox directory. Defaults to the path
# the docker compose files mount the shared volume at — operators can
# override via env if they're running outside compose.
_DEFAULT_INBOX = "/data/baked-imports"


def _inbox_dir() -> Path:
    return Path(os.environ.get("GENY_BAKED_IMPORTS_DIR", _DEFAULT_INBOX))


def _is_safe_filename(name: str) -> bool:
    """Reject filenames that try to escape the inbox via path tricks."""
    if not name or name in (".", ".."):
        return False
    if "/" in name or "\\" in name or "\0" in name:
        return False
    # Reject leading dot (hidden files) and explicit traversal.
    if name.startswith("."):
        return False
    return True


class BakedImportEntry(BaseModel):
    """One pending zip in the inbox."""
    filename: str
    size_bytes: int
    modified_iso: str
    # Best-effort metadata pulled from the zip's `avatar-editor.json`
    # (geny-avatar's buildModelZip writes one). When the zip doesn't
    # have it (older exports / hand-made zips), these stay None and the
    # UI falls back to filename heuristics.
    runtime: Optional[str] = None
    suggested_name: Optional[str] = None
    schema_version: Optional[int] = None


def _peek_zip_metadata(zip_path: Path) -> dict[str, Any]:
    """Open the zip read-only, look for avatar-editor.json, return its
    contents as a dict. Returns {} on any failure — peek must never
    throw, because the user still needs to see the entry to delete it.
    """
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            for candidate in ("avatar-editor.json", "avatar.json"):
                if candidate in zf.namelist():
                    import json as _json
                    with zf.open(candidate) as f:
                        return _json.loads(f.read().decode("utf-8"))
    except Exception as e:
        logger.debug(f"[baked-imports] zip peek failed for {zip_path.name}: {e}")
    return {}


@router.get("/list")
async def list_baked_imports() -> dict[str, Any]:
    """List all pending baked-puppet zips in the inbox.

    Sorted newest-first by mtime so the most recent "send to Geny" lands
    at the top of the UI list.
    """
    inbox = _inbox_dir()
    if not inbox.exists():
        # Not an error — empty inbox until avatar-editor first writes.
        return {"inbox": str(inbox), "entries": [], "exists": False}

    entries: list[BakedImportEntry] = []
    for p in inbox.iterdir():
        if not p.is_file() or p.suffix.lower() != ".zip":
            continue
        try:
            stat = p.stat()
            meta = _peek_zip_metadata(p)
            entries.append(
                BakedImportEntry(
                    filename=p.name,
                    size_bytes=stat.st_size,
                    modified_iso=datetime.fromtimestamp(
                        stat.st_mtime, tz=timezone.utc
                    ).isoformat(),
                    runtime=meta.get("puppet", {}).get("runtime") or meta.get("runtime"),
                    suggested_name=meta.get("puppet", {}).get("name") or meta.get("name"),
                    schema_version=meta.get("schemaVersion") or meta.get("schema_version"),
                )
            )
        except Exception as e:
            logger.warning(f"[baked-imports] skipping {p.name}: {e}")

    entries.sort(key=lambda e: e.modified_iso, reverse=True)
    return {
        "inbox": str(inbox),
        "exists": True,
        "entries": [e.model_dump() for e in entries],
    }


@router.delete("/{filename}")
async def delete_baked_import(filename: str) -> dict[str, Any]:
    """Drop a pending zip. Path-traversal-safe."""
    if not _is_safe_filename(filename):
        raise HTTPException(400, f"unsafe filename: {filename!r}")
    if not filename.lower().endswith(".zip"):
        raise HTTPException(400, "filename must end in .zip")

    target = _inbox_dir() / filename
    if not target.exists() or not target.is_file():
        raise HTTPException(404, f"not found: {filename}")
    try:
        target.unlink()
    except OSError as e:
        # Most common cause in production: the inbox is mounted read-only.
        # Surface the underlying errno text so operators know to look at
        # the compose volume mount.
        raise HTTPException(
            500,
            f"delete failed (volume may be read-only): {e}",
        ) from e

    logger.info(f"[baked-imports] deleted {target}")
    return {"status": "ok", "deleted": filename}
