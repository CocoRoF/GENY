"""SessionUserFileChannel — Geny's ``UserFileChannel`` implementation.

The executor ships a ``SendUserFile`` built-in tool that delegates delivery to
``ctx.extras["user_file_channel"]`` (see geny-executor
``channels/user_file_channel.py``). Until now Geny never wired a channel, so
the tool was dead. This implementation makes agent-produced files land in the
user's chat as attachments:

1. The file is materialised under the session's own storage — agent artefacts
   belong to the session (workspace/outputs/), not a global store — and exposed via
   the session storage raw endpoint
   (``GET /api/agents/{sid}/storage-raw/{relpath}``; cookie-auth'd, so the
   chat ``<img>``/``<a>`` tags work same-origin).
2. A ``ChatAttachment``-shaped dict is buffered per turn. After the turn,
   ``AgentSession.consume_user_file_attachments()`` drains the buffer into
   ``ExecutionResult.attachments`` → chat message ``attachments`` → the
   existing ``AttachmentList`` renderer (no frontend change).
"""

from __future__ import annotations

import mimetypes
import re
import shutil

from service.utils.async_fs import copy2_async
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, List, Optional

from geny_executor.channels.user_file_channel import UserFileChannel

logger = getLogger(__name__)

# Where delivered artefacts live inside the session storage. Part of the
# session files-workspace convention (docs/workspace-canvas-plan/01_PLAN.md):
#   workspace/uploads/  user-uploaded copies
#   workspace/drafts/   in-progress working copies
#   workspace/outputs/      finished, user-delivered artefacts
OUT_SUBDIR = "workspace/outputs"

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._\- ()\[\]가-힣]+")


def _safe_filename(name: str) -> str:
    """Strip path separators / control chars; keep it a plain basename."""
    base = Path(name).name.strip() or "file"
    return _SAFE_NAME_RE.sub("_", base)[:120]


class SessionUserFileChannel(UserFileChannel):
    """Per-session channel: deliver files as chat attachments."""

    def __init__(self, session_id: str, storage_path: str) -> None:
        self._session_id = session_id
        self._storage_root = Path(storage_path).resolve()
        self._pending: List[Dict[str, Any]] = []

    async def send(
        self,
        path: Path,
        *,
        filename: Optional[str] = None,
        content_type: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        src = Path(path).resolve()
        name = _safe_filename(filename or src.name)

        # Materialise under session storage. Files already inside the session
        # storage are referenced in place; anything else (e.g. /tmp scratch)
        # is copied into workspace/outputs/ so the download link stays valid for
        # the session's lifetime.
        try:
            rel = src.relative_to(self._storage_root)
        except ValueError:
            out_dir = self._storage_root / OUT_SUBDIR
            out_dir.mkdir(parents=True, exist_ok=True)
            dest = out_dir / name
            if dest.exists() and dest.stat().st_size != src.stat().st_size:
                dest = out_dir / f"{dest.stem}_{src.stat().st_size}{dest.suffix}"
            await copy2_async(src, dest)
            rel = dest.relative_to(self._storage_root)

        mime = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        size = src.stat().st_size
        url = f"/api/agents/{self._session_id}/storage-raw/{rel.as_posix()}"

        attachment: Dict[str, Any] = {
            "kind": "image" if mime.startswith("image/") else "file",
            "name": name,
            "mime_type": mime,
            "size": size,
            "url": url,
        }
        if description:
            attachment["description"] = description
        self._pending.append(attachment)
        logger.info(
            "[%s] user file staged for delivery: %s (%s, %d bytes)",
            self._session_id, rel.as_posix(), mime, size,
        )
        # This dict is what the LLM sees as the tool result — keep it small
        # and actionable.
        return {
            "download_url": url,
            "filename": name,
            "size": size,
            "note": "The file will appear in the user's chat as an attachment with this message.",
        }

    def drain(self) -> List[Dict[str, Any]]:
        """Return-and-clear the attachments staged during the current turn."""
        pending, self._pending = self._pending, []
        return pending


__all__ = ["SessionUserFileChannel", "OUT_SUBDIR"]
