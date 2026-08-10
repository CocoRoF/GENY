"""Screen observations are a buffer, not an archive — effect-proving tests.

An observation is a note about what was on screen a moment ago. It is not a
record of anything that happened between the user and the agent: the frames
the persona actually spoke about get promoted to `memory/attachments/` and
embedded in the execution record, which is what survives.

Keeping the rest forever grew a production vault at ~757 notes/day until
99.5% of it was machine-authored. A COUNT bounds that; a time window does
not, because the capture rate is nobody's constant.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from service.vtuber import screen_observation as so


class _Manager:
    """Memory manager stand-in — deletes route through it so the vector
    index and sidecars follow."""

    def __init__(self, *, fail: bool = False) -> None:
        self.deleted: list[str] = []
        self.fail = fail

    async def adelete_note(self, filename: str) -> bool:
        if self.fail:
            raise RuntimeError("provider down")
        self.deleted.append(filename)
        (self.root / filename).unlink(missing_ok=True)
        return True


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "memory" / "observations"
    root.mkdir(parents=True)
    mgr = _Manager()
    mgr.root = root
    agent = type("A", (), {"memory_manager": mgr})()
    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: agent)
    return tmp_path, root, mgr


def _make(root: Path, n: int, *, with_frames: bool = False) -> None:
    """n notes, oldest first by mtime."""
    for i in range(n):
        note = root / f"obs-{i:03d}.md"
        note.write_text(f"observation {i}", encoding="utf-8")
        import os
        os.utime(note, (1_700_000_000 + i, 1_700_000_000 + i))
        if with_frames:
            (root / f"obs-{i:03d}.png").write_bytes(b"frame")


@pytest.mark.asyncio
async def test_only_the_newest_notes_survive(vault, monkeypatch):
    """THE property."""
    storage, root, mgr = vault
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "20")
    _make(root, 50)

    dropped = await so._enforce_observation_cap("sid", storage)

    assert dropped == 30
    left = sorted(p.name for p in root.glob("*.md"))
    assert len(left) == 20
    assert left[0] == "obs-030.md", "kept the wrong end of the buffer"
    assert "obs-049.md" in left


@pytest.mark.asyncio
async def test_a_buffer_under_the_cap_is_untouched(vault, monkeypatch):
    storage, root, mgr = vault
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "20")
    _make(root, 5)

    assert await so._enforce_observation_cap("sid", storage) == 0
    assert mgr.deleted == []


@pytest.mark.asyncio
async def test_the_frame_goes_with_its_note(vault, monkeypatch):
    """A frame whose note is gone is unreachable — leaving it behind is the
    387 MB of orphaned images this pipeline already produced once."""
    storage, root, _ = vault
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "2")
    _make(root, 5, with_frames=True)

    await so._enforce_observation_cap("sid", storage)

    assert not (root / "obs-000.png").exists()
    assert (root / "obs-004.png").exists(), "dropped a frame still in the window"


@pytest.mark.asyncio
async def test_zero_disables_the_cap(vault, monkeypatch):
    storage, root, mgr = vault
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "0")
    _make(root, 40)

    assert await so._enforce_observation_cap("sid", storage) == 0
    assert len(list(root.glob("*.md"))) == 40


@pytest.mark.asyncio
async def test_without_a_manager_nothing_is_unlinked(vault, monkeypatch):
    """Never raw-unlink a provider-indexed note — that is exactly how the
    index filled with rows whose files were gone."""
    storage, root, _ = vault
    monkeypatch.setattr(so, "_resolve_agent", lambda _sid: None)
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "2")
    _make(root, 10)

    assert await so._enforce_observation_cap("sid", storage) == 0
    assert len(list(root.glob("*.md"))) == 10


@pytest.mark.asyncio
async def test_a_failing_delete_does_not_abort_the_cap(vault, monkeypatch):
    storage, root, mgr = vault
    mgr.fail = True
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "2")
    _make(root, 6)

    assert await so._enforce_observation_cap("sid", storage) == 0
    assert len(list(root.glob("*.md"))) == 6, "a failed delete removed files anyway"


@pytest.mark.asyncio
async def test_the_cap_is_not_throttled(vault, monkeypatch):
    """A count checked once an hour is not a cap, it is an average. In the
    steady state each new frame must evict exactly one."""
    storage, root, mgr = vault
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "3")
    _make(root, 4)

    assert await so._enforce_observation_cap("sid", storage) == 1
    import os
    note = root / "obs-100.md"
    note.write_text("new", encoding="utf-8")
    os.utime(note, (1_800_000_000, 1_800_000_000))

    assert await so._enforce_observation_cap("sid", storage) == 1
    assert len(list(root.glob("*.md"))) == 3


def test_the_default_is_a_short_buffer():
    """Twenty is a working memory of the last hour or so of screen time, not
    an archive."""
    import os
    os.environ.pop("GENY_SCREEN_OBS_MAX_NOTES", None)
    assert so._max_observation_notes() == 20


def test_a_broken_setting_falls_back(monkeypatch):
    monkeypatch.setenv("GENY_SCREEN_OBS_MAX_NOTES", "많이")
    assert so._max_observation_notes() == 20
