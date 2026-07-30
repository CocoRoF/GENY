"""Media retention sweep — age window + size budget over observation
frames, with the conservative guarantees the pipeline map demands:
.md notes survive, attachments are opt-in, infra dirs are skipped.
"""

from __future__ import annotations

from datetime import date

import pytest

from service.memory.media_retention import (
    sweep_all_sessions,
    sweep_session_media,
)

TODAY = date(2026, 7, 30)


def _mk_frames(d, day: str, n: int, size: int = 100_000, with_md: bool = False):
    dd = d / "memory" / "observations" / day
    dd.mkdir(parents=True, exist_ok=True)
    for i in range(n):
        (dd / f"frame{i}.png").write_bytes(b"x" * size)
    if with_md:
        (dd / "sidecar.md").write_text("관측 노트", encoding="utf-8")
    return dd


def test_age_window_drops_old_dirs_keeps_recent_and_md(tmp_path, monkeypatch):
    """EFFECT PROOF: date dirs past the window lose their media (bytes
    measured), recent dirs and .md sidecars survive."""
    monkeypatch.setenv("GENY_SCREEN_OBS_RETENTION_DAYS", "7")
    monkeypatch.setenv("GENY_SCREEN_OBS_BUDGET_MB", "10000")
    old = _mk_frames(tmp_path, "2026-07-01", 5, with_md=True)   # 29일 경과
    fresh = _mk_frames(tmp_path, "2026-07-28", 5)               # 2일 경과

    m = sweep_session_media(tmp_path, today=TODAY)

    assert m["obs_dirs_dropped"] == 1
    assert m["obs_bytes_freed"] == 5 * 100_000
    assert not any(old.glob("*.png"))            # media gone
    assert (old / "sidecar.md").exists()         # note text preserved
    assert len(list(fresh.glob("*.png"))) == 5   # recent untouched


def test_size_budget_drops_oldest_first(tmp_path, monkeypatch):
    """EFFECT PROOF: within the age window, the tree is still bounded —
    oldest date dirs go first until under budget."""
    monkeypatch.setenv("GENY_SCREEN_OBS_RETENTION_DAYS", "30")
    monkeypatch.setenv("GENY_SCREEN_OBS_BUDGET_MB", "1")  # 1 MiB budget
    d1 = _mk_frames(tmp_path, "2026-07-25", 6, size=200_000)  # 1.2 MB
    d2 = _mk_frames(tmp_path, "2026-07-29", 4, size=100_000)  # 0.4 MB

    m = sweep_session_media(tmp_path, today=TODAY)

    assert m["obs_dirs_dropped"] == 1
    assert not d1.exists() or not any(d1.glob("*.png"))  # oldest dropped
    assert len(list(d2.glob("*.png"))) == 4              # newest kept
    # surviving tree fits the budget
    total = sum(p.stat().st_size for p in
                (tmp_path / "memory" / "observations").rglob("*.png"))
    assert total <= 1024 * 1024


def test_attachments_default_untouched_and_opt_in(tmp_path, monkeypatch):
    """attachments/ is the permanent referenced-frame archive — swept ONLY
    when the operator explicitly opts in."""
    att = tmp_path / "memory" / "attachments" / "2026-06-01"
    att.mkdir(parents=True)
    (att / "frame.png").write_bytes(b"y" * 50_000)

    monkeypatch.delenv("GENY_ATTACHMENTS_RETENTION_DAYS", raising=False)
    m = sweep_session_media(tmp_path, today=TODAY)
    assert m["att_dirs_dropped"] == 0 and (att / "frame.png").exists()

    monkeypatch.setenv("GENY_ATTACHMENTS_RETENTION_DAYS", "30")
    m2 = sweep_session_media(tmp_path, today=TODAY)
    assert m2["att_dirs_dropped"] == 1
    assert not (att / "frame.png").exists()


def test_retention_zero_disables(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_SCREEN_OBS_RETENTION_DAYS", "0")
    d = _mk_frames(tmp_path, "2020-01-01", 2)
    m = sweep_session_media(tmp_path, today=TODAY)
    assert m["obs_dirs_dropped"] == 0 and len(list(d.glob("*.png"))) == 2


def test_sweep_all_skips_infra_dirs(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_SCREEN_OBS_RETENTION_DAYS", "7")
    monkeypatch.setenv("GENY_SCREEN_OBS_BUDGET_MB", "10000")
    _mk_frames(tmp_path / "sess-1", "2026-07-01", 3)
    _mk_frames(tmp_path / "_HANG_QUARANTINE" / "x", "2026-07-01", 3)

    totals = sweep_all_sessions(tmp_path)

    assert totals["sessions"] == 1
    assert totals["obs_dirs_dropped"] == 1
    # quarantine left alone
    q = tmp_path / "_HANG_QUARANTINE" / "x" / "memory" / "observations" / "2026-07-01"
    assert len(list(q.glob("*.png"))) == 3
