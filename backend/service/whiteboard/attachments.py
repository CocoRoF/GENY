"""
Attachment storage helpers — Phase 0.

Binary files (screenshots, audio, drawings, dropped files) are stored
under ``{vault}/_attachments/`` next to the user's existing notes:

    {STORAGE_ROOT}/_user_opsidian/{username}/_attachments/<safe-name>

Notes reference attachments via Obsidian-style wikilinks::

    ![[2026-05-07-091034.png]]

These helpers do not parse or rewrite note bodies — they just put
binaries in the right place safely. The wikilink rendering happens
client-side in `AttachmentEmbed.tsx` (Phase 1).
"""

from __future__ import annotations

import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional


_ATTACHMENTS_DIR = "_attachments"
_CAPTURES_LOG = "_captures.jsonl"

# Conservative — alphanumerics, hyphen, underscore, period only.
# Anything else gets replaced. Path separators MUST not survive.
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]")


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def safe_attachment_name(suggested: Optional[str], *, default_ext: str = "bin") -> str:
    """Return a filesystem-safe attachment basename.

    The result is always a leaf name (no separators), preserves the
    extension when one is detectable, and falls back to a UTC-stamped
    random name when ``suggested`` is empty.
    """
    if suggested:
        # Strip any path components an over-eager client may have sent.
        suggested = os.path.basename(str(suggested))
    if not suggested:
        return f"{_utc_stamp()}-{secrets.token_hex(4)}.{default_ext.strip('.')}"

    stem, dot, ext = suggested.rpartition(".")
    if not dot:
        stem, ext = suggested, default_ext
    safe_stem = _SAFE_NAME_RE.sub("_", stem).strip("._-") or "capture"
    safe_ext = _SAFE_NAME_RE.sub("", ext).lower() or default_ext.strip(".")
    return f"{safe_stem}.{safe_ext}"


def attachments_dir(vault_root: str) -> Path:
    """Return the ``_attachments`` directory under ``vault_root``.

    The directory is created lazily on first save. ``vault_root`` is
    expected to be ``{STORAGE_ROOT}/_user_opsidian/{username}`` — the
    same directory ``UserOpsidianManager`` writes notes into.
    """
    return Path(vault_root) / _ATTACHMENTS_DIR


def ensure_attachments_dir(vault_root: str) -> Path:
    target = attachments_dir(vault_root)
    target.mkdir(parents=True, exist_ok=True)
    return target


def save_attachment(
    vault_root: str,
    data: bytes,
    *,
    suggested_name: Optional[str] = None,
    default_ext: str = "bin",
) -> str:
    """Write ``data`` as a new attachment file. Returns the relative path.

    The relative path is what notes embed via wikilink, e.g.
    ``"_attachments/2026-05-07-091034-ab12.png"``. Collisions are
    avoided by appending a random suffix to the stem until the name
    is unused.
    """
    target_dir = ensure_attachments_dir(vault_root)
    base_name = safe_attachment_name(suggested_name, default_ext=default_ext)

    candidate = target_dir / base_name
    while candidate.exists():
        stem, dot, ext = base_name.rpartition(".")
        suffix = secrets.token_hex(3)
        if dot:
            base_name = f"{stem}-{suffix}.{ext}"
        else:
            base_name = f"{base_name}-{suffix}"
        candidate = target_dir / base_name

    candidate.write_bytes(data)
    return f"{_ATTACHMENTS_DIR}/{base_name}"


def read_attachment(vault_root: str, relative_path: str) -> Optional[bytes]:
    """Return the bytes for a previously saved attachment, if accessible.

    Refuses any path that escapes the vault's ``_attachments`` directory
    (defence against ``../`` traversal in user-supplied input).
    """
    cleaned = (relative_path or "").lstrip("/").replace("\\", "/")
    if not cleaned:
        return None
    base = ensure_attachments_dir(vault_root).resolve()
    target = (Path(vault_root) / cleaned).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    if not target.is_file():
        return None
    try:
        return target.read_bytes()
    except OSError:
        return None


def list_attachments(vault_root: str) -> Iterable[str]:
    """Iterate relative paths for every attachment in the vault."""
    base = attachments_dir(vault_root)
    if not base.is_dir():
        return ()
    items = []
    for entry in base.iterdir():
        if entry.is_file():
            items.append(f"{_ATTACHMENTS_DIR}/{entry.name}")
    items.sort()
    return items


def delete_attachment(vault_root: str, relative_path: str) -> bool:
    cleaned = (relative_path or "").lstrip("/").replace("\\", "/")
    if not cleaned:
        return False
    base = ensure_attachments_dir(vault_root).resolve()
    target = (Path(vault_root) / cleaned).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return False
    if not target.is_file():
        return False
    try:
        target.unlink()
        return True
    except OSError:
        return False


def captures_log_path(vault_root: str) -> Path:
    """Path to the per-vault append-only capture audit log."""
    return Path(vault_root) / _CAPTURES_LOG


def append_capture_log(vault_root: str, entry: dict) -> None:
    """Append a JSON line to ``_captures.jsonl``. Best-effort, never raises."""
    import json

    path = captures_log_path(vault_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except OSError:
        # Audit log is a nice-to-have — never block the capture path.
        pass
