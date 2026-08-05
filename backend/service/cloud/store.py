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


# ── which agents are connected to the cloud ─────────────────────────────
#
# The cloud owns the membership list, not the sessions: it is the hub, it
# outlives any agent, and one file answers "who is connected" in a single
# read at session build time.

_AGENTS_FILE = ".geny-cloud-agents.json"


def _agents_file(username: str) -> Path:
    return Path(cloud_storage_path(username)) / _AGENTS_FILE


def connected_sessions(username: str) -> list:
    try:
        import json

        with open(_agents_file(username), "r", encoding="utf-8") as f:
            data = json.load(f)
        ids = data.get("sessions") or []
        return [str(x) for x in ids if isinstance(x, (str, int))]
    except (OSError, ValueError):
        return []


def is_connected(username: str, session_id: str) -> bool:
    return session_id in connected_sessions(username)


def set_connected(username: str, session_id: str, connected: bool) -> list:
    import json

    current = connected_sessions(username)
    if connected and session_id not in current:
        current.append(session_id)
    elif not connected and session_id in current:
        current.remove(session_id)
    tmp = _agents_file(username).with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"sessions": current}, f)
    os.replace(tmp, _agents_file(username))
    return current


def cloud_workspace(username: str) -> str:
    """The directory an agent actually reads and writes."""
    return str(Path(cloud_storage_path(username)) / "workspace")


#: Name the cloud takes inside a connected agent's workspace.
CLOUD_LINK_NAME = "cloud"


def ensure_agent_link(storage_path: str, username: str) -> bool:
    """Give a connected agent a natural path to the cloud.

    A symlink at ``workspace/cloud`` — which works because the executor's
    path guard resolves the link FIRST and then checks containment against
    ``allowed_paths``; adding the cloud there is what makes the traversal
    legal. Without the link the agent would have to name an absolute
    ``/data/..._cloud/<user>/workspace`` path, which is both ugly and
    leaks the storage layout into prompts.

    The sync indexer skips symlinks (``followlinks=False`` + explicit
    ``is_symlink()`` checks), so this can never duplicate the cloud into
    the agent's own mirror — the reference stays a reference.
    """
    link = Path(storage_path) / "workspace" / CLOUD_LINK_NAME
    target = cloud_workspace(username)
    try:
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.is_symlink():
            if os.readlink(str(link)) == target:
                return True
            link.unlink()
        elif link.exists():
            return False  # a real file/dir sits there — never clobber
        os.symlink(target, str(link), target_is_directory=True)
        return True
    except OSError:
        return False


def remove_agent_link(storage_path: str) -> None:
    link = Path(storage_path) / "workspace" / CLOUD_LINK_NAME
    try:
        if link.is_symlink():
            link.unlink()
    except OSError:
        pass
