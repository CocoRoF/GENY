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
from typing import Optional

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


# ── Paired computers ──────────────────────────────────────────────────
#
# The user's machines are one of the three things that attach to a cloud
# (the others being agents and, through a machine, individual folders), so
# they need to be nameable when they are switched off. A live socket list
# alone would make a laptop vanish from the picture the moment it sleeps,
# which reads as "unpaired" rather than "offline" — and the folders it
# shares would lose the machine they belong to.
#
# So attachments are remembered here. Registration happens when a replica
# connects; nothing is ever auto-removed, because a machine the user has
# not explicitly unpaired is still theirs.

_DEVICES_FILE = ".geny-cloud-devices.json"
_MAX_DEVICES = 100


def _devices_file(username: str) -> Path:
    return Path(cloud_storage_path(username)) / _DEVICES_FILE


def known_devices(username: str) -> list:
    """Every computer that has ever attached to this cloud, newest first."""
    try:
        import json

        with open(_devices_file(username), "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("devices") or []
        return [d for d in items if isinstance(d, dict) and d.get("device_id")]
    except (OSError, ValueError):
        return []


def remember_device(username: str, device_id: str, device_name: str) -> None:
    """Record an attachment (upsert by device_id, refreshing name/last_seen).

    Best-effort bookkeeping: callers run it off the hot path and swallow
    failures. Losing a row costs a rail entry until the next connect; it
    must never cost the connection that triggered it.
    """
    import json
    import time

    device_id = str(device_id or "").strip()[:64]
    if not device_id or device_id == "unknown":
        return
    device_name = str(device_name or "").strip()[:64]

    rows = [d for d in known_devices(username) if d.get("device_id") != device_id]
    rows.insert(0, {
        "device_id": device_id,
        "device_name": device_name,
        "last_seen": int(time.time()),
    })
    del rows[_MAX_DEVICES:]

    path = _devices_file(username)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"devices": rows}, f, ensure_ascii=False)
    os.replace(tmp, path)


def forget_device(username: str, device_id: str) -> list:
    """Unpair a computer. Its files are untouched — this only drops the row."""
    import json

    rows = [d for d in known_devices(username) if d.get("device_id") != device_id]
    path = _devices_file(username)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"devices": rows}, f, ensure_ascii=False)
    os.replace(tmp, path)
    return rows


def cloud_workspace(username: str) -> str:
    """The directory an agent actually reads and writes."""
    return str(Path(cloud_storage_path(username)) / "workspace")


#: Name the cloud takes inside a connected agent's workspace.
# ── The cloud IS the filesystem ───────────────────────────────────────
#
#   <cloud>/workspace/
#     ├── <linked folder>/       user bind directories (from their PCs)
#     ├── agents/<session_id>/   an agent's own working space
#     │     └── .gapt/           its GAPT sandbox, when the agent starts one
#     └── gapt/<name>/           a GAPT workspace the USER set up independently
#
# Agent workspaces live INSIDE the cloud rather than beside it. The previous
# layout put them in a sibling directory and reached the cloud through a
# `workspace/cloud` symlink, which broke the moment the agent ran in a GAPT
# sandbox: the link pointed at a path that exists only in the backend
# container, so inside the sandbox it dangled (measured). With the agent
# already standing in the cloud there is no link to dangle, and one mirror on
# the user's PC carries the whole shared space — which is the point of it
# being shared.
#
# What does NOT move: a session's internal state (memory/, transcripts/,
# checkpoints/, synapse.db — 87 MB on one production session) stays at
# ``<ROOT>/<session_id>/``. It is machinery, not work product, and replicating
# it to every laptop would be both wasteful and confusing.

#: Where agent spaces are grouped. Reserved: a linked folder may not take it.
AGENTS_SUBDIR = "agents"

#: Where a user-configured, agent-independent GAPT workspace lives. Kept at
#: the top level and NOT under ``agents/`` precisely so the two are
#: distinguishable at a glance — and so an agent can see (and be told about)
#: a GAPT space that is not its own.
GAPT_SUBDIR = "gapt"

#: Names the cloud owns. A user folder linked under one of these would be
#: mirrored on top of the structure.
RESERVED_CLOUD_NAMES = frozenset({AGENTS_SUBDIR, GAPT_SUBDIR})


def agents_root(username: str) -> str:
    """``<cloud>/workspace/agents`` — parent of every agent space."""
    return str(Path(cloud_workspace(username)) / AGENTS_SUBDIR)


def agent_space(username: str, session_id: str) -> str:
    """An agent's own working directory, inside the cloud."""
    return str(Path(agents_root(username)) / _safe_user_dir(session_id))


def agent_gapt_space(username: str, session_id: str) -> str:
    """The GAPT workspace an agent starts for itself — under its own space,
    so the sandbox it creates cannot be confused with the user's."""
    return str(Path(agent_space(username, session_id)) / ".gapt")


def user_gapt_root(username: str) -> str:
    """``<cloud>/workspace/gapt`` — GAPT workspaces the user set up."""
    return str(Path(cloud_workspace(username)) / GAPT_SUBDIR)


def ensure_agent_space(username: str, session_id: str) -> str:
    """Create (idempotently) the agent's directory inside the cloud."""
    path = Path(agent_space(username, session_id))
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def cloud_relative(username: str, absolute: str) -> Optional[str]:
    """Path as the user sees it in the cloud, or None if it is outside.

    Used to tell an agent where it stands without leaking the storage root
    into a prompt.
    """
    try:
        return str(Path(absolute).resolve().relative_to(
            Path(cloud_workspace(username)).resolve()
        ))
    except (ValueError, OSError):
        return None


def adopt_agent_space(username: str, storage_path: str, session_id: str) -> str:
    """Move a session's workspace INTO the cloud, once, and leave a link.

    Returns the agent's cloud path. Idempotent and never destructive:

    * if the legacy ``<storage>/workspace`` is a real directory, its contents
      move into ``<cloud>/workspace/agents/<sid>/`` and the old path becomes a
      symlink to it — so every place that joins ``storage_path / "workspace"``
      keeps working unchanged;
    * a name that already exists on the cloud side is NOT overwritten; the
      incoming copy is kept beside it as ``<name>.local-<n>``, because both
      sides are real work and choosing between them is not ours to do;
    * once the link is in place the call only ensures the target exists.

    The sync indexer skips symlinks, so the legacy path contributes nothing to
    the session's own journal — the cloud journal is the single owner of these
    bytes, which is what keeps one path to one engine.

    This replaces the previous ``workspace/cloud`` symlink, which pointed the
    other way and broke inside a GAPT sandbox: its target only exists in the
    backend container, so the link dangled there (measured in production).
    An agent standing inside the cloud has no link to dangle.
    """
    target = Path(ensure_agent_space(username, session_id))
    legacy = Path(storage_path) / "workspace"

    try:
        if legacy.is_symlink():
            if os.readlink(str(legacy)) != str(target):
                legacy.unlink()
                os.symlink(str(target), str(legacy), target_is_directory=True)
            return str(target)

        if legacy.is_dir():
            for entry in sorted(legacy.iterdir()):
                # The old `workspace/cloud` link pointed at the cloud root.
                # Carrying it in would make the agent's own space contain a
                # link to its own ancestor — a cycle that a mount or an
                # explorer walks forever. The agent is inside the cloud now,
                # so the link has nothing left to express.
                if entry.is_symlink() and entry.name == "cloud":
                    try:
                        if Path(os.readlink(str(entry))).resolve() == Path(
                            cloud_workspace(username)
                        ).resolve():
                            entry.unlink()
                            continue
                    except OSError:
                        pass
                dest = target / entry.name
                if dest.exists() or dest.is_symlink():
                    n = 2
                    while (target / f"{entry.name}.local-{n}").exists():
                        n += 1
                    dest = target / f"{entry.name}.local-{n}"
                os.replace(str(entry), str(dest))
            legacy.rmdir()

        legacy.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(str(target), str(legacy), target_is_directory=True)
    except OSError:
        # Best-effort: a session whose workspace could not be moved keeps
        # working on the legacy path rather than losing it.
        return str(legacy)
    return str(target)


def owning_storage(storage_path: str, username: str = "") -> tuple:
    """Which journal owns this scope's bytes, and under which prefix.

    Returns ``(storage_path, prefix)``. An agent whose workspace has been
    adopted holds no bytes of its own — they live in the cloud at
    ``agents/<sid>/`` — so quota and usage must be read there. Answering from
    the session's own (now empty) journal would report 0 B and, worse, switch
    quota enforcement off for every agent write.
    """
    ws = Path(storage_path) / "workspace"
    try:
        if not ws.is_symlink():
            return storage_path, ""
        target = Path(os.readlink(str(ws)))
    except OSError:
        return storage_path, ""

    user = username or ""
    if not user:
        # Derive the owner from the link itself: <cloud>/<user>/workspace/...
        try:
            rel = target.relative_to(cloud_root())
            user = rel.parts[0] if rel.parts else ""
        except (ValueError, OSError):
            return storage_path, ""
    if not user:
        return storage_path, ""

    prefix = cloud_relative(user, str(target))
    if prefix is None:
        return storage_path, ""
    return cloud_storage_path(user, create=False), prefix


def release_agent_space(storage_path: str) -> None:
    """Drop only the compatibility link. The agent's files stay in the cloud —
    they are shared work product, not session scratch."""
    legacy = Path(storage_path) / "workspace"
    try:
        if legacy.is_symlink():
            legacy.unlink()
    except OSError:
        pass
