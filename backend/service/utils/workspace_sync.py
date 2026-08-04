"""Workspace sync index — the server-side half of the Drive-style
local↔workspace synchronisation.

The session workspace (``<storage>/<sid>/workspace``) is the single
source of truth (agent working_dir = GAPT bind = sub-agent share = web
explorer). Desktop connectors on any number of PCs hold replicas and
converge through this module's three primitives:

* a persisted **content index** (path, sha256, monotonically increasing
  ``seq``, tombstones) in ``<storage>/.geny-sync/index.db`` — outside
  workspace/ so it never syncs itself;
* :func:`refresh_index` — incremental rescan: stat-walk the tree, hash
  ONLY entries whose ``(mtime_ns, size)`` changed, tombstone the
  vanished ones;
* :func:`changes_since` — cursor read model: everything after a seq.

Every function here does blocking file/SQLite IO — callers on the event
loop MUST wrap them in ``asyncio.to_thread`` (see the Synapse loop-wedge
incident: sqlite on the loop froze the pod).
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from service.utils.file_storage import (
    DEFAULT_IGNORE_PATTERNS,
    load_gitignore_patterns,
)

logger = logging.getLogger(__name__)

# Never index these (relative to workspace/). The explorer's preview
# cache and our own machinery must not ping-pong between replicas.
SYNC_EXTRA_IGNORES = [
    ".geny-sync/",
    ".geny-sync-tmp/",
    ".canvas-preview/",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "*.crdownload",
    "*.partial",
    "*.tmp",
    "~$*",           # Office lock files
    ".~lock.*#",     # LibreOffice lock files
]

# Tombstones older than this are pruned — an offline replica that stayed
# away longer must bootstrap from since=0 anyway.
_TOMBSTONE_TTL_S = 30 * 24 * 3600

# Minimum interval between full rescans of one workspace (refresh storms
# from polling clients collapse into one scan).
_SCAN_THROTTLE_S = 2.0

_HASH_CHUNK = 1024 * 1024

# per-storage-root serialization + throttle bookkeeping
_LOCKS: Dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()
_LAST_SCAN: Dict[str, float] = {}


def _lock_for(key: str) -> threading.Lock:
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = _LOCKS[key] = threading.Lock()
        return lock


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path(storage_path: str) -> Path:
    return Path(storage_path) / ".geny-sync" / "index.db"


def _hwm_path(storage_path: str) -> Path:
    return Path(storage_path) / ".geny-sync" / "seq.hwm"


def _read_hwm(storage_path: str) -> int:
    try:
        return int(_hwm_path(storage_path).read_text().strip() or 0)
    except (OSError, ValueError):
        return 0


def _write_hwm(storage_path: str, seq: int) -> None:
    """Seq high-water mark OUTSIDE the sqlite file — survives an index
    rebuild so seq never regresses (a regressed journal would strand
    every replica whose cursor is past the new latest)."""
    try:
        _hwm_path(storage_path).write_text(str(seq))
    except OSError:
        pass


def _connect(storage_path: str) -> sqlite3.Connection:
    path = _db_path(storage_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fresh = not path.exists()
    conn = sqlite3.connect(str(path), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS entries(
               path TEXT PRIMARY KEY,
               is_dir INTEGER NOT NULL DEFAULT 0,
               size INTEGER NOT NULL DEFAULT 0,
               mtime_ns INTEGER NOT NULL DEFAULT 0,
               sha256 TEXT NOT NULL DEFAULT '',
               seq INTEGER NOT NULL,
               deleted INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL
           )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_seq ON entries(seq)")
    conn.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    if fresh:
        # Rebuilt (or first-ever) index: seed seq from the high-water mark
        # so it stays monotonic across rebuilds. Also mark every cursor
        # older than this point stale — tombstones did not survive.
        hwm = _read_hwm(storage_path)
        if hwm > 0:
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('seq', ?) "
                "ON CONFLICT(key) DO NOTHING",
                (str(hwm),),
            )
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('prune_watermark', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(hwm),),
            )
            conn.commit()
    return conn


def _next_seq(conn: sqlite3.Connection, bump: int = 1) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key='seq'").fetchone()
    cur = int(row[0]) if row else 0
    nxt = cur + bump
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('seq', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(nxt),),
    )
    return nxt


def latest_seq(storage_path: str) -> int:
    conn = _connect(storage_path)
    try:
        row = conn.execute("SELECT value FROM meta WHERE key='seq'").fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(_HASH_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _build_ignore_spec(storage_path: str, session_id: str = ""):
    """One compiled matcher per refresh — pathspec if available."""
    patterns = (
        list(DEFAULT_IGNORE_PATTERNS)
        + load_gitignore_patterns(storage_path, session_id)
        + SYNC_EXTRA_IGNORES
    )
    try:
        import pathspec

        return pathspec.PathSpec.from_lines("gitwildmatch", patterns)
    except Exception:  # pragma: no cover - fallback exercised only без pathspec
        from service.utils.file_storage import should_ignore_path

        class _Fallback:
            def match_file(self, rel: str) -> bool:
                return should_ignore_path(rel, patterns, session_id)

        return _Fallback()


def _walk_workspace(ws: Path, spec) -> Dict[str, Tuple[bool, int, int]]:
    """Stat-walk → {rel_path: (is_dir, size, mtime_ns)}. Ignored dirs are
    pruned from descent (never entered), symlinks skipped entirely."""
    out: Dict[str, Tuple[bool, int, int]] = {}
    for root, dirs, files in os.walk(ws, followlinks=False):
        root_p = Path(root)
        rel_root = "" if root_p == ws else str(root_p.relative_to(ws)).replace("\\", "/")
        keep_dirs = []
        for d in dirs:
            rel = f"{rel_root}/{d}" if rel_root else d
            if spec.match_file(rel) or spec.match_file(rel + "/"):
                continue
            if (root_p / d).is_symlink():
                continue
            keep_dirs.append(d)
            try:
                st = (root_p / d).stat()
                out[rel] = (True, 0, st.st_mtime_ns)
            except OSError:
                continue
        dirs[:] = keep_dirs
        for f in files:
            rel = f"{rel_root}/{f}" if rel_root else f
            if spec.match_file(rel):
                continue
            fp = root_p / f
            if fp.is_symlink():
                continue
            try:
                st = fp.stat()
            except OSError:
                continue
            out[rel] = (False, st.st_size, st.st_mtime_ns)
    return out


def _reset_index(storage_path: str) -> None:
    """Drop a corrupt index — it is DERIVED state and rebuilds on the
    next scan. Cost of the reset: tombstones are lost, so replicas that
    were offline may resurrect recently-deleted files (data-preserving
    degradation, never data loss)."""
    base = _db_path(storage_path)
    for suffix in ("", "-wal", "-shm"):
        Path(str(base) + suffix).unlink(missing_ok=True)
    logger.warning("workspace sync index reset (corruption): %s", base)


def refresh_index(
    storage_path: str,
    session_id: str = "",
    *,
    force: bool = False,
    _retried: bool = False,
) -> Dict[str, int]:
    """Incremental rescan of ``<storage>/workspace`` into the index.

    Cheap by construction: one stat-walk; sha256 recomputed ONLY for
    entries whose (mtime_ns, size) moved. Returns
    ``{latest_seq, added, updated, deleted, hashed}``.
    Throttled to one scan per _SCAN_THROTTLE_S unless ``force``.
    Self-heals: a corrupt SQLite file is deleted and rebuilt once.
    """
    try:
        return _refresh_index_inner(storage_path, session_id, force=force)
    except sqlite3.DatabaseError:
        if _retried:
            raise
        _reset_index(storage_path)
        return refresh_index(storage_path, session_id, force=True, _retried=True)


def _refresh_index_inner(
    storage_path: str,
    session_id: str = "",
    *,
    force: bool = False,
) -> Dict[str, int]:
    key = str(Path(storage_path).resolve())
    lock = _lock_for(key)
    with lock:
        now = time.monotonic()
        if not force and now - _LAST_SCAN.get(key, 0.0) < _SCAN_THROTTLE_S:
            return {"latest_seq": latest_seq(storage_path), "added": 0,
                    "updated": 0, "deleted": 0, "hashed": 0, "throttled": 1}
        _LAST_SCAN[key] = now

        ws = Path(storage_path) / "workspace"
        ws.mkdir(parents=True, exist_ok=True)
        spec = _build_ignore_spec(storage_path, session_id)
        current = _walk_workspace(ws, spec)

        conn = _connect(storage_path)
        stats = {"added": 0, "updated": 0, "deleted": 0, "hashed": 0}
        try:
            rows = conn.execute(
                "SELECT path, is_dir, size, mtime_ns, sha256, deleted FROM entries"
            ).fetchall()
            known: Dict[str, Tuple[int, int, int, str, int]] = {
                r[0]: (r[1], r[2], r[3], r[4], r[5]) for r in rows
            }

            ts = _now_iso()
            for rel, (is_dir, size, mtime_ns) in current.items():
                old = known.get(rel)
                if old is not None and not old[4]:  # live row
                    o_dir, o_size, o_mtime, _o_sha, _ = old
                    if bool(o_dir) == is_dir and o_size == size and o_mtime == mtime_ns:
                        continue  # unchanged — no rehash, no seq
                sha = ""
                if not is_dir:
                    try:
                        sha = _sha256_file(ws / rel)
                        stats["hashed"] += 1
                    except OSError:
                        continue
                seq = _next_seq(conn)
                conn.execute(
                    """INSERT INTO entries(path, is_dir, size, mtime_ns, sha256,
                                            seq, deleted, updated_at)
                       VALUES(?,?,?,?,?,?,0,?)
                       ON CONFLICT(path) DO UPDATE SET
                         is_dir=excluded.is_dir, size=excluded.size,
                         mtime_ns=excluded.mtime_ns, sha256=excluded.sha256,
                         seq=excluded.seq, deleted=0, updated_at=excluded.updated_at""",
                    (rel, 1 if is_dir else 0, size, mtime_ns, sha, seq, ts),
                )
                if old is None or old[4]:
                    stats["added"] += 1
                else:
                    stats["updated"] += 1

            # vanished → tombstone
            for rel, (_d, _s, _m, _sha, deleted) in known.items():
                if deleted or rel in current:
                    continue
                seq = _next_seq(conn)
                conn.execute(
                    "UPDATE entries SET deleted=1, seq=?, sha256='', size=0, "
                    "updated_at=? WHERE path=?",
                    (seq, ts, rel),
                )
                stats["deleted"] += 1

            # Prune ancient tombstones — and RECORD the highest pruned seq
            # as the stale-cursor watermark: a replica whose cursor is
            # older than a pruned delete can no longer converge from a
            # delta and must re-bootstrap (changes_since signals it).
            cutoff_iso = datetime.fromtimestamp(
                datetime.now(timezone.utc).timestamp() - _TOMBSTONE_TTL_S,
                timezone.utc,
            ).isoformat()
            pruned = conn.execute(
                "SELECT MAX(seq) FROM entries WHERE deleted=1 AND updated_at < ?",
                (cutoff_iso,),
            ).fetchone()
            if pruned and pruned[0]:
                wm_row = conn.execute(
                    "SELECT value FROM meta WHERE key='prune_watermark'"
                ).fetchone()
                wm = max(int(wm_row[0]) if wm_row else 0, int(pruned[0]))
                conn.execute(
                    "INSERT INTO meta(key, value) VALUES('prune_watermark', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(wm),),
                )
                conn.execute(
                    "DELETE FROM entries WHERE deleted=1 AND updated_at < ?",
                    (cutoff_iso,),
                )

            conn.commit()
            row = conn.execute("SELECT value FROM meta WHERE key='seq'").fetchone()
            stats["latest_seq"] = int(row[0]) if row else 0
            _write_hwm(storage_path, stats["latest_seq"])
            return stats
        finally:
            conn.close()


def changes_since(storage_path: str, since: int) -> Dict:
    """Cursor read model.

    ``since=0`` → bootstrap snapshot: every LIVE entry (no tombstones —
    a fresh replica has nothing to delete). ``since>0`` → every row
    (including tombstones) with ``seq > since``.
    """
    conn = _connect(storage_path)
    try:
        if since <= 0:
            rows = conn.execute(
                "SELECT path, is_dir, size, mtime_ns, sha256, seq, deleted "
                "FROM entries WHERE deleted=0 ORDER BY seq"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT path, is_dir, size, mtime_ns, sha256, seq, deleted "
                "FROM entries WHERE seq > ? ORDER BY seq",
                (since,),
            ).fetchall()
        meta = conn.execute("SELECT value FROM meta WHERE key='seq'").fetchone()
        wm_row = conn.execute(
            "SELECT value FROM meta WHERE key='prune_watermark'"
        ).fetchone()
        watermark = int(wm_row[0]) if wm_row else 0
        return {
            "latest_seq": int(meta[0]) if meta else 0,
            # Cursor no longer usable: tombstones up to `watermark` were
            # pruned (or the index was rebuilt) — deltas from an older
            # cursor would silently miss deletions. Replicas re-bootstrap.
            "stale_cursor": bool(0 < since < watermark),
            "changes": [
                {
                    "path": r[0],
                    "is_dir": bool(r[1]),
                    "size": r[2],
                    "mtime_ns": r[3],
                    "sha256": r[4],
                    "seq": r[5],
                    "deleted": bool(r[6]),
                }
                for r in rows
            ],
        }
    finally:
        conn.close()


def quota_bytes() -> int:
    """Workspace total-size quota (env-tunable; 0 disables)."""
    try:
        return int(os.environ.get("GENY_WORKSPACE_QUOTA_MB", "10240")) * 1024 * 1024
    except ValueError:
        return 10240 * 1024 * 1024


def used_bytes_if_indexed(storage_path: str) -> Optional[int]:
    """used_bytes, but STRICTLY read-only: None when no index exists yet.

    The storage summary endpoint calls this for every owned session — a GET
    must not mkdir + create a SQLite index inside sessions that never used
    the storage API (observed side effect), and an empty fresh index would
    report a misleading 0 B for workspaces that hold files written by agent
    tools. None lets the UI show "not indexed" instead of a false zero.
    """
    if not _db_path(storage_path).exists():
        return None
    return used_bytes(storage_path)


def used_bytes(storage_path: str) -> int:
    """Total live file bytes per the index (cheap SQL, no walk)."""
    conn = _connect(storage_path)
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(size), 0) FROM entries WHERE deleted=0 AND is_dir=0"
        ).fetchone()
        return int(row[0] or 0)
    finally:
        conn.close()


# ── chunked/resumable upload staging ─────────────────────────────────
#
# Large files (connector-side threshold) arrive as sequential chunks into
# <storage>/.geny-sync-tmp/chunks/<upload_id>.part with a .meta sidecar,
# then commit atomically with the same base_sha conflict dance as PUT.

_CHUNK_TTL_S = 24 * 3600
_UPLOAD_ID_RE = re.compile(r"^[a-f0-9]{32}$")


def chunk_dir(storage_path: str) -> Path:
    return Path(storage_path) / ".geny-sync-tmp" / "chunks"


def valid_upload_id(upload_id: str) -> bool:
    return bool(_UPLOAD_ID_RE.match(upload_id or ""))


def gc_stale_uploads(storage_path: str) -> int:
    """Drop chunk staging older than the TTL. Returns files removed."""
    d = chunk_dir(storage_path)
    if not d.is_dir():
        return 0
    cutoff = time.time() - _CHUNK_TTL_S
    removed = 0
    for p in d.iterdir():
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def current_sha(storage_path: str, rel_ws_path: str) -> Optional[str]:
    """Live sha for one workspace-relative path from the index; None if
    the index has no live row (caller may fall back to hashing)."""
    conn = _connect(storage_path)
    try:
        row = conn.execute(
            "SELECT sha256, deleted FROM entries WHERE path=?", (rel_ws_path,)
        ).fetchone()
        if row and not row[1]:
            return row[0]
        return None
    finally:
        conn.close()


def hash_file(path: Path) -> str:
    """Public streaming sha256 (used by the PUT endpoint for base_sha
    verification when the index is stale)."""
    return _sha256_file(path)


def locked_delete(storage_path: str, target: Path, base_sha: Optional[str]) -> Optional[str]:
    """Verify-and-delete under the per-storage lock (same anti-race
    contract as commit_file — a guarded delete must not destroy a write
    that landed after the caller's pre-check). Returns None on success,
    the current sha on base_sha conflict. Raises FileNotFoundError when
    the target is already gone. Blocking — call via asyncio.to_thread."""
    import shutil

    lock = _lock_for(str(Path(storage_path).resolve()))
    with lock:
        if not target.exists():
            raise FileNotFoundError(str(target))
        if base_sha and target.is_file():
            cur = _sha256_file(target)
            if cur != base_sha:
                return cur
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        return None


def locked_rename(storage_path: str, src: Path, dst: Path) -> Optional[str]:
    """Rename under the per-storage lock with a no-clobber guarantee —
    ``os.rename`` silently replaces an existing dst on POSIX, so the
    exists-check must be atomic with the rename against every other
    lock-holding writer. Returns None on success, 'src_missing' or
    'dst_exists' on refusal. Blocking — call via asyncio.to_thread."""
    lock = _lock_for(str(Path(storage_path).resolve()))
    with lock:
        if not src.exists():
            return "src_missing"
        if dst.exists():
            return "dst_exists"
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return None


def commit_file(storage_path: str, tmp: Path, target: Path, base_sha: str) -> Optional[str]:
    """Atomically place *tmp* at *target* IFF the target still matches
    *base_sha* — the last line of defence against the streaming race:

        replica A: check sha ─ stream (seconds…) ─ replace
        replica B:      check sha ─ stream ─ replace   ← would silently win

    The pre-check both replicas passed is stale by replace time; this
    re-verifies UNDER the per-storage lock so concurrent PUTs serialize.
    Returns None on success, or the target's CURRENT sha on conflict
    (caller answers 409; tmp is removed either way on conflict).
    Blocking — call via asyncio.to_thread.
    """
    lock = _lock_for(str(Path(storage_path).resolve()))
    with lock:
        if target.exists():
            if target.is_dir():
                tmp.unlink(missing_ok=True)
                return "__is_dir__"
            cur = _sha256_file(target)
            if cur != base_sha:
                tmp.unlink(missing_ok=True)
                return cur
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, target)
        return None
