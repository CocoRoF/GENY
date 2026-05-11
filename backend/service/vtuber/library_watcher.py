"""
Library inbox watcher — periodically mirrors the
/data/baked-imports directory into Geny's model registry.

Backed by the Option-B architecture: avatar-editor writes baked
zips directly to the shared docker volume (its /exports →
backend's /data/baked-imports), and this loop is what makes
them appear in Geny's model selector. No HTTP coupling between
the two services — the filesystem is the contract.

Loop responsibilities:

  1. Install any new zips at the inbox top level whose puppet.id
     isn't already in the registry. Calls the existing
     install_baked_import flow with `keep_source=True` so the zip
     stays in the inbox (it is the source of truth — moving it
     to `installed/` would falsely look like a delete to the next
     scan).

  2. Unregister any model entries whose puppet.id no longer has
     a matching zip in the inbox top level. The user deleted the
     puppet from geny-avatar's library; avatar-editor's
     `/api/library/{id}` route already unlinked the zip from the
     volume, this scan just propagates that to the registry.

Files inside `installed/` are ignored — those are archives of
manual installs from the legacy `Avatar 가져오기` UI, not the
auto-publish source of truth.

Failure mode: every step is best-effort. A bad zip logs a
warning and stays in place (next scan re-tries). A registry
write failure doesn't abort the rest of the scan.
"""

from __future__ import annotations

import asyncio
import json as _json
import os
import zipfile
from logging import getLogger
from pathlib import Path
from typing import Optional

from fastapi import FastAPI

logger = getLogger(__name__)

_DEFAULT_INBOX = "/data/baked-imports"
_DEFAULT_INTERVAL_S = 5.0


def _inbox_dir() -> Path:
    return Path(os.environ.get("GENY_BAKED_IMPORTS_DIR", _DEFAULT_INBOX))


def _peek_puppet_id(zip_path: Path) -> Optional[str]:
    """Read the puppet.id out of the zip's avatar-editor.json
    sidecar. Returns None when the file isn't present (legacy zip)
    or the sidecar lacks an id field. Never throws."""
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            for candidate in ("avatar-editor.json", "avatar.json"):
                if candidate in zf.namelist():
                    with zf.open(candidate) as f:
                        meta = _json.loads(f.read().decode("utf-8"))
                    return (meta.get("puppet") or {}).get("id")
    except Exception as e:
        logger.debug(f"[library-watcher] zip peek failed for {zip_path.name}: {e}")
    return None


async def _scan_once(app: FastAPI) -> None:
    """One scan pass. Best-effort; never raises."""
    manager = getattr(app.state, "live2d_model_manager", None)
    if manager is None:
        return
    inbox = _inbox_dir()
    if not inbox.exists():
        return

    # Collect the inbox-top-level zips paired with their puppet ids
    # and on-disk mtime so the two passes below share one stat() +
    # peek per zip. The mtime drives change detection: avatar-editor's
    # auto-publish rewrites `<puppet_id>.zip` atomically on every IDB
    # change, so a newer mtime than the registered entry's
    # `inbox_mtime` is the signal that the user renamed or re-baked
    # this puppet and the registry needs to follow.
    try:
        candidates: list[tuple[Path, Optional[str], float]] = []
        for entry in inbox.iterdir():
            if not entry.is_file() or entry.suffix.lower() != ".zip":
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            candidates.append((entry, _peek_puppet_id(entry), mtime))
    except OSError as e:
        logger.warning(f"[library-watcher] inbox scan failed: {e}")
        return

    inbox_puppet_ids = {pid for _, pid, _ in candidates if pid}

    # Pass 1: install any zip whose puppet.id isn't registered yet, or
    # re-install when the source zip is newer than what we have on
    # record. Use a lazy import to avoid the controller ↔ service
    # circular import that would otherwise form (controller imports
    # live2d_model_manager from service; if service imported controller
    # at module load it would loop).
    from controller.vtuber_baked_imports_controller import (
        InstallRequest,
        install_baked_import,
    )

    class _MockRequest:
        """Minimal FastAPI-Request stand-in. install_baked_import
        only reads `request.app.state.live2d_model_manager`."""

        def __init__(self, real_app: FastAPI):
            self.app = real_app

    mock_req = _MockRequest(app)

    # Small epsilon to absorb cross-filesystem mtime granularity
    # quirks (some FS round to whole seconds). 1ms is well below any
    # real-world rename interval but big enough to ignore floating
    # point round-trips through JSON.
    MTIME_EPSILON_S = 0.001

    for zip_path, puppet_id, mtime in candidates:
        if not puppet_id:
            continue  # legacy / unidentifiable zip — leave alone
        prior = manager.find_by_puppet_id(puppet_id)
        if prior is not None:
            # Already registered. Only re-install when the zip on disk
            # has been rewritten since the last install we logged. The
            # install path will reuse the model.name + extract dir so
            # existing session assignments keep pointing at the same
            # entry (display_name and other fields refresh in place).
            prior_mtime = prior.inbox_mtime
            if prior_mtime is not None and mtime <= prior_mtime + MTIME_EPSILON_S:
                continue
            action = "re-install (mtime change)"
        else:
            action = "install (new)"
        try:
            req = InstallRequest(
                filename=zip_path.name,
                replace_existing=False,
                keep_source=True,  # don't move; inbox is the source of truth
            )
            result = await install_baked_import(req, mock_req)  # type: ignore[arg-type]
            model = result.get("model") or {}
            logger.info(
                f"[library-watcher] {action} {zip_path.name} "
                f"→ name={model.get('name')!r} display={model.get('display_name')!r}"
            )
        except Exception as e:
            logger.warning(
                f"[library-watcher] {action} failed for {zip_path.name}: {e}"
            )

    # Pass 2: unregister any model whose source zip is gone from
    # the inbox top level. Only touches entries that carry a
    # puppet_id — hand-installed models without one stay regardless.
    from controller.vtuber_baked_imports_controller import _drop_model_with_dir

    def _models_root_for(info) -> Optional[Path]:
        # Mirror the rest of the controller's `static/<runtime>-models`
        # convention. Lazy import to avoid the cycle described above.
        from controller.vtuber_baked_imports_controller import (
            _live2d_models_root,
            _spine_models_root,
        )

        parts = (info.url or "").lstrip("/").split("/")
        if len(parts) >= 3 and parts[0] == "static":
            if parts[1] == "live2d-models":
                return _live2d_models_root()
            if parts[1] == "spine-models":
                return _spine_models_root()
        return None

    for info in list(manager.list_models()):
        if not info.puppet_id:
            continue
        if info.puppet_id in inbox_puppet_ids:
            continue
        root = _models_root_for(info)
        if root is None:
            logger.warning(
                f"[library-watcher] orphan {info.name!r} has unrecognized url={info.url!r}; "
                f"dropping registry entry only"
            )
            manager.remove_model(info.name)
        else:
            _drop_model_with_dir(manager, info, root)
        logger.info(
            f"[library-watcher] auto-unregistered {info.name!r} "
            f"(puppet_id={info.puppet_id!r}) — source zip gone"
        )


async def _watcher_loop(app: FastAPI, interval_s: float) -> None:
    """Run scans on a fixed interval until the task is cancelled.
    Sleeps in chunks so a shutdown signal during the sleep doesn't
    have to wait a whole interval to take effect."""
    logger.info(
        f"[library-watcher] started (inbox={_inbox_dir()}, interval={interval_s}s)"
    )
    try:
        while True:
            try:
                await _scan_once(app)
            except Exception as e:
                logger.warning(f"[library-watcher] scan threw: {e}")
            await asyncio.sleep(interval_s)
    except asyncio.CancelledError:
        logger.info("[library-watcher] stopped")
        raise


def start_library_watcher(app: FastAPI) -> asyncio.Task:
    """Spawn the watcher as a background task. Caller (the FastAPI
    lifespan handler) keeps the returned task so it can be cancelled
    on shutdown. Interval can be tuned via env."""
    interval_s = float(
        os.environ.get("GENY_LIBRARY_WATCHER_INTERVAL_S", _DEFAULT_INTERVAL_S)
    )
    return asyncio.create_task(_watcher_loop(app, interval_s))
