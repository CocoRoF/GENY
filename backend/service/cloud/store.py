"""
GenyCloud store — one cloud folder per USER, above every agent.

The model:

    [user's extra folders] ↔ [local GenyCloud] ↔ [SERVER CLOUD] ↔ [agent workspace]

Everything gathers in the server cloud. Agents keep their own workspace
but connect to the cloud; connected agents operate on the SAME bytes,
not on copies — which is the whole point of moving the hub here. Copies
per agent were what made the old model multiply: one shared folder became
N server-side copies, N engines and N revocations.

WHY THE LAYOUT LOOKS LIKE A SESSION
-----------------------------------
A cloud lives at ``<ROOT>/_cloud/<username>/`` with its files under
``workspace/`` and its journal in ``.geny-sync/`` — byte-for-byte the
same shape a session storage root has. That is deliberate: every piece
of machinery already built for workspaces (seq journal, tombstones,
base_sha commits, chunked uploads, quota, the changes feed, the WebDAV
provider, the native drive daemon) takes a *storage path* and works. The
cloud gets all of it for free, and there is exactly one implementation of
"what a synced folder means" instead of two that can drift.

The ``_`` prefix is the established convention for non-session roots
(_user_opsidian, _curated_knowledge, _global_memory): session sweeps skip
underscore-prefixed directories, so a cloud can never be mistaken for a
dead agent and reaped.
"""
from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path

from service.utils.platform import DEFAULT_STORAGE_ROOT

#: Storage-scope id addressing "the calling user's cloud". The storage API
#: is scope-generic: handlers take a scope id and resolve it to a storage
#: path, so this one value routes every existing endpoint at the cloud
#: without a parallel implementation. It can never address someone else's
#: cloud — the path is derived from the caller's own token, not from the id.
CLOUD_SCOPE_ID = "_cloud"

_UNSAFE = re.compile(r"[^A-Za-z0-9._@\-]")


def is_cloud_scope(scope_id: str) -> bool:
    return scope_id == CLOUD_SCOPE_ID


def _safe_user_dir(username: str) -> str:
    """Filesystem-safe directory name for a username.

    Usernames are free-form (they are just the JWT ``sub``), so anything
    that could traverse or collide is folded away. The mapping only has to
    be stable and injective enough that two accounts never share a folder;
    unusual characters become '_' and the original is preserved in the
    name where it is safe.
    """
    name = unicodedata.normalize("NFC", (username or "").strip())
    name = _UNSAFE.sub("_", name)
    name = name.strip(". ") or "user"
    return name[:100]


def cloud_root() -> Path:
    return Path(os.environ.get("GENY_CLOUD_ROOT") or (Path(DEFAULT_STORAGE_ROOT) / "_cloud"))


def cloud_storage_path(username: str, create: bool = True) -> str:
    """Storage root of a user's cloud — the argument every storage helper
    already takes. ``workspace/`` under it holds the actual files."""
    path = cloud_root() / _safe_user_dir(username)
    if create:
        (path / "workspace").mkdir(parents=True, exist_ok=True)
    return str(path)


def cloud_notify_key(username: str) -> str:
    """Change-notification key for this user's cloud.

    The workspace WS hub is keyed by scope string; every user's cloud
    shares the id ``_cloud``, so the key must carry the username or one
    user's write would wake every other user's replicas.
    """
    return f"{CLOUD_SCOPE_ID}:{_safe_user_dir(username)}"
