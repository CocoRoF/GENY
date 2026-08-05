"""
Geny Drive WebDAV provider.

Layout served at /dav (Basic auth with per-device app passwords):

    /dav/                     ← the authenticated user's agents, as folders
    /dav/<agent-name>/…       ← that agent's workspace/ subtree

Design contract (why it looks the way it does):

- **Disk-direct, journal-integrated.** Reads and listings go straight to
  the filesystem (os.scandir per directory — cheap depth-1, no recursive
  walks). Writes are journal-integrated: temp file + os.replace under the
  same per-storage lock the sync API uses, followed by a forced index
  refresh, so mirror connectors and the changes feed see DAV writes as
  first-class events. The inotify watcher (workspace_stream) provides the
  live-push half; we deliberately do NOT call notify_workspace_changed
  from here — it flips an asyncio.Event and is only safe on the event
  loop, while this code runs in the WSGI threadpool. The watcher's own
  rescan delivers the push within ~1 s whenever a replica is connected.

- **Last-writer-wins, not base_sha.** The sync REST API demands base_sha
  because replicas race across long streams. A mounted filesystem has
  filesystem semantics — the OS client already serialized the user's
  intent, and no DAV client can supply a base sha. The atomic
  replace-under-lock still guarantees no torn files and no lost index
  updates.

- **NFC everywhere.** macOS sends NFD; every incoming DAV path is
  normalized to NFC before it touches the mapping, so "한글.txt" is one
  file regardless of client OS.

- **Reuses wsgidav's battle-tested FileResource/FolderResource** for the
  protocol corner cases (ranges, etags, COPY/MOVE recursion) and only
  overrides the seams where Geny semantics differ (writes, deletes,
  moves — anything that must hit the journal; plus quota).
"""
from __future__ import annotations

import logging
import os
import time
import unicodedata
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from wsgidav import util
from wsgidav.dav_error import (
    DAVError,
    HTTP_FORBIDDEN,
)
from wsgidav.dav_provider import DAVCollection, DAVProvider
from wsgidav.fs_dav_provider import FileResource, FolderResource

logger = logging.getLogger(__name__)

HTTP_INSUFFICIENT_STORAGE = 507

# Windows-reserved characters + control chars are stripped from share
# names so every agent folder is mountable on every OS.
_BAD = set('<>:"/\\|?*')


def _safe_share_name(raw: str) -> str:
    name = unicodedata.normalize("NFC", (raw or "").strip())
    name = "".join(("_" if (c in _BAD or ord(c) < 32) else c) for c in name)
    name = name.rstrip(". ")  # Windows forbids trailing dot/space
    return name[:80] or "agent"


@dataclass
class AgentShare:
    session_id: str
    name: str            # share folder name shown at /dav/
    storage_path: str    # session storage root (workspace/ lives under it)

    @property
    def workspace(self) -> str:
        return os.path.join(self.storage_path, "workspace")


class AgentDirectory:
    """username → {share_name: AgentShare}, with a short TTL cache.

    PROPFIND storms hit the root frequently; the session-store scan runs
    at most once per TTL per user. The resolver is injectable so the
    provider can be litmus-tested without a running backend.
    """

    def __init__(
        self,
        resolver: Callable[[str], List[AgentShare]],
        ttl_s: float = 15.0,
    ) -> None:
        self._resolver = resolver
        self._ttl = ttl_s
        self._cache: Dict[str, tuple] = {}  # user -> (monotonic, mapping)

    def shares_for(self, username: str) -> Dict[str, AgentShare]:
        now = time.monotonic()
        hit = self._cache.get(username)
        if hit and (now - hit[0]) < self._ttl:
            return hit[1]
        mapping: Dict[str, AgentShare] = {}
        try:
            for share in self._resolver(username):
                name = _safe_share_name(share.name)
                # Deterministic collision suffixing (case-insensitive, like
                # the connector's drive folder allocation).
                candidate, i = name, 2
                taken = {k.casefold() for k in mapping}
                while candidate.casefold() in taken:
                    candidate = f"{name}-{i}"
                    i += 1
                share.name = candidate
                mapping[candidate] = share
        except Exception as e:  # noqa: BLE001
            logger.error(f"[dav] agent resolve failed for {username}: {e}")
            # Serve the stale mapping rather than an empty drive on a
            # transient store hiccup.
            if hit:
                return hit[1]
        self._cache[username] = (now, mapping)
        return mapping

    def invalidate(self) -> None:
        self._cache.clear()


def default_agent_resolver(username: str) -> List[AgentShare]:
    """Session-store-backed resolver with the SAME ownership semantics as
    the REST layer (verify_session_ownership): explicit owner must match,
    ownerless legacy records fail open, GENY_ADMIN_USERS bypass."""
    from service.sessions.store import get_session_store
    from service.auth.auth_middleware import _admin_users

    from service.cloud import CLOUD_SCOPE_ID, cloud_storage_path

    # The CLOUD first: it is the storage above the agents, and a mount
    # that only showed agent workspaces would hide the place everything
    # actually gathers.
    out: List[AgentShare] = [
        AgentShare(
            session_id=CLOUD_SCOPE_ID,
            name="Cloud",
            storage_path=cloud_storage_path(username),
        )
    ]
    records = get_session_store().list_all() or []
    is_admin = username in _admin_users()
    for rec in records:
        if rec.get("is_deleted"):
            continue
        owner = rec.get("owner_username")
        if owner and owner != username and not is_admin:
            continue
        sid = str(rec.get("session_id") or "")
        storage = str(rec.get("storage_path") or "")
        if not sid or not storage:
            continue
        ws = os.path.join(storage, "workspace")
        if not os.path.isdir(ws):
            continue
        out.append(
            AgentShare(
                session_id=sid,
                name=str(rec.get("session_name") or sid[:8]),
                storage_path=storage,
            )
        )
    return out


# ── journal integration helpers ─────────────────────────────────────────


def _refresh_journal(share: AgentShare) -> None:
    """Force the sync index to absorb a DAV write immediately. Runs in the
    WSGI thread (sqlite + hashing are blocking — that's fine here). Never
    raises: journal bookkeeping must not fail the client's operation; the
    throttled refresh on the next /changes poll is the safety net."""
    try:
        from service.utils import workspace_sync

        workspace_sync.refresh_index(share.storage_path, share.session_id, force=True)
    except Exception as e:  # noqa: BLE001
        logger.debug(f"[dav] journal refresh failed for {share.session_id}: {e}")


def _quota_guard(share: AgentShare, incoming_bytes: int, replacing: Optional[str]) -> None:
    """507 when the write would exceed the workspace quota. Uses the same
    index-backed accounting as the sync API, so the two surfaces enforce
    one number."""
    try:
        from service.utils import workspace_sync

        quota = workspace_sync.quota_bytes()
        used = workspace_sync.used_bytes(share.storage_path)
        old = 0
        if replacing and os.path.isfile(replacing):
            old = os.path.getsize(replacing)
        projected = used - old + max(0, incoming_bytes)
        if projected > quota:
            raise DAVError(
                HTTP_INSUFFICIENT_STORAGE,
                f"workspace quota exceeded ({projected} > {quota})",
            )
    except DAVError:
        raise
    except Exception as e:  # noqa: BLE001
        # Accounting failure must not block writes (same stance as the API).
        logger.debug(f"[dav] quota check skipped: {e}")


# ── resources ───────────────────────────────────────────────────────────


class GenyFileResource(FileResource):
    """File with atomic journal-integrated writes and X-OC-Mtime."""

    def __init__(self, path, environ, file_path, share: AgentShare):
        super().__init__(path, environ, file_path)
        self._share = share
        self._tmp_path: Optional[str] = None

    def begin_write(self, *, content_type=None):
        if self.provider.readonly:
            raise DAVError(HTTP_FORBIDDEN)
        # Stream into a sibling temp file; the real path changes only via
        # os.replace under the storage lock in end_write. A crashed/aborted
        # PUT therefore never leaves a torn file at the target.
        self._tmp_path = f"{self._file_path}.dav-{os.getpid()}-{id(self)}.tmp"
        return open(self._tmp_path, "wb", 8192)

    def end_write(self, *, with_errors):
        tmp = self._tmp_path
        self._tmp_path = None
        if tmp is None:
            return
        if with_errors:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return
        try:
            size = os.path.getsize(tmp)
            _quota_guard(self._share, size, self._file_path)

            from service.utils import workspace_sync

            with workspace_sync._lock_for(self._share.storage_path):
                os.replace(tmp, self._file_path)

            # rclone/Nextcloud extension: honor the client's modification
            # time so a mounted tree keeps true timestamps instead of upload
            # times. Seconds (possibly fractional) since epoch.
            hdr = self.environ.get("HTTP_X_OC_MTIME")
            if hdr:
                try:
                    mtime = float(hdr)
                    os.utime(self._file_path, (mtime, mtime))
                except (ValueError, OSError):
                    pass

            _refresh_journal(self._share)
        except DAVError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def delete(self):
        super().delete()
        _refresh_journal(self._share)

    def copy_move_single(self, dest_path, *, is_move):
        super().copy_move_single(dest_path, is_move=is_move)
        _refresh_journal(self._share)
        dest_share = self.provider.share_for_path(dest_path, self.environ)
        if dest_share and dest_share.session_id != self._share.session_id:
            _refresh_journal(dest_share)

    def move_recursive(self, dest_path):
        super().move_recursive(dest_path)
        _refresh_journal(self._share)
        dest_share = self.provider.share_for_path(dest_path, self.environ)
        if dest_share and dest_share.session_id != self._share.session_id:
            _refresh_journal(dest_share)


class GenyFolderResource(FolderResource):
    def __init__(self, path, environ, file_path, share: AgentShare):
        super().__init__(path, environ, file_path)
        self._share = share

    def create_collection(self, name):
        res = super().create_collection(name)
        _refresh_journal(self._share)
        return res

    def delete(self):
        super().delete()
        _refresh_journal(self._share)

    def copy_move_single(self, dest_path, *, is_move):
        super().copy_move_single(dest_path, is_move=is_move)
        _refresh_journal(self._share)

    def move_recursive(self, dest_path):
        super().move_recursive(dest_path)
        _refresh_journal(self._share)
        dest_share = self.provider.share_for_path(dest_path, self.environ)
        if dest_share and dest_share.session_id != self._share.session_id:
            _refresh_journal(dest_share)

    # RFC 4331 quota properties — Finder shows a real drive size, rclone
    # `about` works. Reported per agent share (each agent has its own
    # quota-accounted workspace).
    def get_used_bytes(self):
        try:
            from service.utils import workspace_sync

            used = workspace_sync.used_bytes_if_indexed(self._share.storage_path)
            return used if used is not None else None
        except Exception:  # noqa: BLE001
            return None

    def get_available_bytes(self):
        try:
            from service.utils import workspace_sync

            used = workspace_sync.used_bytes_if_indexed(self._share.storage_path)
            if used is None:
                return None
            return max(0, workspace_sync.quota_bytes() - used)
        except Exception:  # noqa: BLE001
            return None


class RootCollection(DAVCollection):
    """Virtual, read-only: one folder per owned agent."""

    def __init__(self, environ, shares: Dict[str, AgentShare]):
        super().__init__("/", environ)
        self._shares = shares

    def get_member_names(self):
        return sorted(self._shares.keys())

    def get_member(self, name):
        return self.provider.get_resource_inst(
            util.join_uri(self.path, name), self.environ
        )

    # Creating/deleting at the root would mean creating/deleting AGENTS —
    # that's an application decision, not a filesystem one.
    def create_empty_resource(self, name):
        raise DAVError(HTTP_FORBIDDEN, "The drive root lists agents; create files inside an agent folder")

    def create_collection(self, name):
        raise DAVError(HTTP_FORBIDDEN, "The drive root lists agents; create folders inside an agent folder")

    def delete(self):
        raise DAVError(HTTP_FORBIDDEN)

    def copy_move_single(self, dest_path, *, is_move):
        raise DAVError(HTTP_FORBIDDEN)


class GenyDAVProvider(DAVProvider):
    def __init__(self, directory: AgentDirectory):
        super().__init__()
        self.directory = directory
        self.readonly = False
        self.fs_opts: Dict = {}

    # ── path plumbing ────────────────────────────────────────────────

    def _username(self, environ: dict) -> str:
        return environ.get("wsgidav.auth.user_name") or ""

    def _split(self, path: str, environ: dict):
        """'/Share/rest' → (AgentShare|None, 'rest')."""
        norm = unicodedata.normalize("NFC", path or "/")
        parts = [p for p in norm.strip("/").split("/") if p]
        if not parts:
            return None, ""
        shares = self.directory.shares_for(self._username(environ))
        share = shares.get(parts[0])
        return share, "/".join(parts[1:])

    def share_for_path(self, path: str, environ: dict) -> Optional[AgentShare]:
        share, _ = self._split(path, environ)
        return share

    def _loc_to_file_path(self, path: str, environ: dict = None) -> str:
        """Used by wsgidav's COPY/MOVE destination resolution as well as by
        us. Chroots strictly inside the share's workspace/ (realpath check,
        symlink escapes included)."""
        share, rest = self._split(path, environ or {})
        if share is None:
            raise DAVError(HTTP_FORBIDDEN, f"No such agent share: {path!r}")
        root = share.workspace
        parts = [p for p in rest.split("/") if p not in ("", ".")]
        if ".." in parts:
            raise DAVError(HTTP_FORBIDDEN)
        fp = os.path.abspath(os.path.join(root, *parts))
        real_root = os.path.realpath(root)
        real_fp = os.path.realpath(fp)
        if not (real_fp == real_root or real_fp.startswith(real_root + os.sep)):
            raise DAVError(HTTP_FORBIDDEN, "Access outside the agent workspace")
        return fp

    # ── resource factory ─────────────────────────────────────────────

    def get_resource_inst(self, path: str, environ: dict):
        self._count_get_resource_inst += 1
        norm = unicodedata.normalize("NFC", path or "/")
        if norm in ("", "/"):
            return RootCollection(environ, self.directory.shares_for(self._username(environ)))
        share, rest = self._split(norm, environ)
        if share is None:
            return None
        fp = self._loc_to_file_path(norm, environ)
        if os.path.isdir(fp):
            return GenyFolderResource(norm, environ, fp, share)
        if os.path.isfile(fp):
            return GenyFileResource(norm, environ, fp, share)
        return None
