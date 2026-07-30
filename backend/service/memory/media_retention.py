"""Media retention sweep — bounds the per-session observation/attachment
media that nothing else cleans up.

The screen-observation pipeline already prunes its own tree — but only
DURING a live upload (throttled 1/hr, 200 notes/sweep, and never for a
session that stopped uploading). Production consequence: a stopped
session kept 387 MB of frames forever. This sweep is the standalone
janitor that covers every session under the storage root, live or
dormant.

Policy (deliberately conservative):

* ``memory/observations/<YYYY-MM-DD>/`` date dirs
  - AGE: dirs older than ``GENY_SCREEN_OBS_RETENTION_DAYS`` (default 7,
    0 disables) are emptied of media and removed. ``.md`` files are
    preserved defensively (the fallback sidecar path can place notes in
    date dirs; flat observation notes are cleaned by the live pruner via
    the provider, keeping the synapse index consistent).
  - SIZE: after the age pass, if the tree still exceeds
    ``GENY_SCREEN_OBS_BUDGET_MB`` (default 256), oldest date dirs are
    dropped first until under budget.
* ``memory/attachments/`` is the PERMANENT bucket — frames the persona
  actually talked about, embedded in execution/conversation records.
  It is only aged when ``GENY_ATTACHMENTS_RETENTION_DAYS`` is explicitly
  set > 0 (default off).

Readers degrade gracefully by design: the media endpoint returns 404 for
a pruned file and note text/captions stay intact, so sweeping frames
never breaks recall — only old thumbnails.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)

_DATE_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _dir_size(path: Path) -> int:
    total = 0
    try:
        for p in path.rglob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    continue
    except OSError:
        pass
    return total


def _date_dirs(root: Path) -> List[Tuple[date, Path]]:
    out: List[Tuple[date, Path]] = []
    try:
        for child in root.iterdir():
            if child.is_dir() and _DATE_DIR.match(child.name):
                try:
                    y, m, d = child.name.split("-")
                    out.append((date(int(y), int(m), int(d)), child))
                except ValueError:
                    continue
    except OSError:
        pass
    out.sort()  # oldest first
    return out


def _drop_media_dir(d: Path) -> int:
    """Delete every non-``.md`` file under *d*, then the dir if empty.
    Returns bytes freed. ``.md`` sidecars survive (note text is cheap and
    the provider-routed pruner owns note deletion)."""
    freed = 0
    try:
        for p in sorted(d.rglob("*"), reverse=True):
            if p.is_file() and p.suffix.lower() != ".md":
                try:
                    freed += p.stat().st_size
                    p.unlink()
                except OSError:
                    continue
        # Remove now-empty directories bottom-up (keeps dirs holding .md).
        for p in sorted(d.rglob("*"), reverse=True):
            if p.is_dir():
                try:
                    p.rmdir()
                except OSError:
                    pass
        d.rmdir()
    except OSError:
        pass
    return freed


def sweep_session_media(storage_path: Path, *, today: date | None = None) -> Dict[str, int]:
    """Apply the retention policy to ONE session dir. Returns metrics."""
    today = today or date.today()
    metrics = {"obs_dirs_dropped": 0, "obs_bytes_freed": 0,
               "att_dirs_dropped": 0, "att_bytes_freed": 0}

    obs_days = _env_int("GENY_SCREEN_OBS_RETENTION_DAYS", 7)
    obs_budget = _env_int("GENY_SCREEN_OBS_BUDGET_MB", 256) * 1024 * 1024
    att_days = _env_int("GENY_ATTACHMENTS_RETENTION_DAYS", 0)

    obs_root = storage_path / "memory" / "observations"
    if obs_days > 0 and obs_root.is_dir():
        cutoff = today - timedelta(days=obs_days)
        remaining: List[Tuple[date, Path]] = []
        for day, d in _date_dirs(obs_root):
            if day < cutoff:
                metrics["obs_bytes_freed"] += _drop_media_dir(d)
                metrics["obs_dirs_dropped"] += 1
            else:
                remaining.append((day, d))
        # Size budget: oldest-first until the surviving tree fits.
        if obs_budget > 0 and remaining:
            sizes = [(day, d, _dir_size(d)) for day, d in remaining]
            total = sum(s for _, _, s in sizes)
            for day, d, s in sizes:  # already oldest-first
                if total <= obs_budget:
                    break
                metrics["obs_bytes_freed"] += _drop_media_dir(d)
                metrics["obs_dirs_dropped"] += 1
                total -= s

    att_root = storage_path / "memory" / "attachments"
    if att_days > 0 and att_root.is_dir():
        cutoff = today - timedelta(days=att_days)
        for day, d in _date_dirs(att_root):
            if day < cutoff:
                metrics["att_bytes_freed"] += _drop_media_dir(d)
                metrics["att_dirs_dropped"] += 1

    return metrics


def sweep_all_sessions(storage_root: str | Path | None = None) -> Dict[str, int]:
    """Retention over EVERY session under the storage root — live or
    dormant. Cheap (stat/iterdir); safe to run on a schedule."""
    if storage_root is None:
        from service.utils.platform import DEFAULT_STORAGE_ROOT

        storage_root = DEFAULT_STORAGE_ROOT
    root = Path(storage_root)
    totals = {"sessions": 0, "obs_dirs_dropped": 0, "obs_bytes_freed": 0,
              "att_dirs_dropped": 0, "att_bytes_freed": 0}
    try:
        children = list(root.iterdir())
    except OSError:
        return totals
    for child in children:
        # Skip infrastructure dirs (_user_opsidian, _HANG_QUARANTINE, …).
        if not child.is_dir() or child.name.startswith("_"):
            continue
        m = sweep_session_media(child)
        if m["obs_dirs_dropped"] or m["att_dirs_dropped"]:
            totals["sessions"] += 1
            for k in ("obs_dirs_dropped", "obs_bytes_freed",
                      "att_dirs_dropped", "att_bytes_freed"):
                totals[k] += m[k]
    if totals["obs_bytes_freed"] or totals["att_bytes_freed"]:
        logger.info(
            "media retention: %d session(s), observations -%d dirs/%.1f MB, "
            "attachments -%d dirs/%.1f MB",
            totals["sessions"], totals["obs_dirs_dropped"],
            totals["obs_bytes_freed"] / 1048576,
            totals["att_dirs_dropped"], totals["att_bytes_freed"] / 1048576)
    return totals
