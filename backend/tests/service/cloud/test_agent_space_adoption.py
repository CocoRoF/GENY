"""Moving an agent's workspace into the cloud — effect-proving tests.

The cloud is the shared working space: the user's linked folders, every
agent's own space, and GAPT workspaces all live in one tree that mirrors to
the user's PCs. Getting an agent there means MOVING files that already exist,
so the properties worth asserting are about what survives:

  · nothing is overwritten — both sides are real work, and choosing between
    them is not this function's call;
  · running it twice does nothing the second time;
  · the legacy path keeps resolving, because ~19 call sites join
    ``storage_path / "workspace"`` and none of them should have to care.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from service.cloud import store


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    session = tmp_path / "sessions" / "sid-1"
    (session / "workspace").mkdir(parents=True)
    return "hr", str(session), "sid-1"


def test_files_move_into_the_cloud_and_the_old_path_still_resolves(world):
    user, storage, sid = world
    ws = Path(storage) / "workspace"
    (ws / "report.md").write_text("agent output", encoding="utf-8")
    (ws / "sub").mkdir()
    (ws / "sub" / "deep.txt").write_text("nested", encoding="utf-8")

    target = Path(store.adopt_agent_space(user, storage, sid))

    assert target == Path(store.agent_space(user, sid))
    assert (target / "report.md").read_text(encoding="utf-8") == "agent output"
    assert (target / "sub" / "deep.txt").read_text(encoding="utf-8") == "nested"
    # The legacy path is a link now, and reading through it still works.
    assert ws.is_symlink()
    assert (ws / "report.md").read_text(encoding="utf-8") == "agent output"


def test_adoption_is_idempotent(world):
    user, storage, sid = world
    (Path(storage) / "workspace" / "a.txt").write_text("x", encoding="utf-8")

    first = store.adopt_agent_space(user, storage, sid)
    second = store.adopt_agent_space(user, storage, sid)

    assert first == second
    assert sorted(p.name for p in Path(first).iterdir()) == ["a.txt"]


def test_a_name_already_in_the_cloud_is_never_overwritten(world):
    """Both copies are real work. The incoming one is kept beside the
    existing one rather than replacing it."""
    user, storage, sid = world
    cloud_side = Path(store.ensure_agent_space(user, sid))
    (cloud_side / "notes.md").write_text("what the cloud had", encoding="utf-8")
    (Path(storage) / "workspace" / "notes.md").write_text("what the session had", encoding="utf-8")

    target = Path(store.adopt_agent_space(user, storage, sid))

    assert (target / "notes.md").read_text(encoding="utf-8") == "what the cloud had"
    assert (target / "notes.md.local-2").read_text(encoding="utf-8") == "what the session had"


def test_an_empty_workspace_adopts_cleanly(world):
    user, storage, sid = world
    target = store.adopt_agent_space(user, storage, sid)
    assert Path(target).is_dir()
    assert (Path(storage) / "workspace").is_symlink()


def test_a_stale_link_is_repointed(world):
    """A session restored under a different user (or a renamed cloud) must
    not keep resolving to the old target."""
    user, storage, sid = world
    ws = Path(storage) / "workspace"
    ws.rmdir()
    os.symlink(str(Path(storage) / "somewhere-else"), str(ws), target_is_directory=True)

    target = store.adopt_agent_space(user, storage, sid)

    assert os.readlink(str(ws)) == target == store.agent_space(user, sid)


def test_release_drops_only_the_link(world):
    user, storage, sid = world
    (Path(storage) / "workspace" / "keep.txt").write_text("shared work", encoding="utf-8")
    target = Path(store.adopt_agent_space(user, storage, sid))

    store.release_agent_space(storage)

    assert not (Path(storage) / "workspace").exists()
    assert (target / "keep.txt").read_text(encoding="utf-8") == "shared work"


# ── the layout itself ───────────────────────────────────────────────

def test_the_three_kinds_of_space_are_distinguishable(world):
    user, _storage, sid = world
    agent = Path(store.agent_space(user, sid))
    agent_gapt = Path(store.agent_gapt_space(user, sid))
    user_gapt = Path(store.user_gapt_root(user))
    cloud = Path(store.cloud_workspace(user))

    # An agent's GAPT sits UNDER that agent; the user's sits beside `agents/`
    # at the top level, so the two can never be mistaken for each other.
    assert agent_gapt.parent == agent
    assert user_gapt.parent == cloud
    assert agent.parent == Path(store.agents_root(user))
    assert user_gapt != agent_gapt
    assert store.RESERVED_CLOUD_NAMES == {"agents", "gapt"}


def test_an_agent_can_be_told_where_it_stands(world):
    """`cloud_relative` is how a prompt says "you are here" without leaking
    the storage root."""
    user, _storage, sid = world
    assert store.cloud_relative(user, store.agent_space(user, sid)) == f"agents/{sid}"
    assert store.cloud_relative(user, store.user_gapt_root(user)) == "gapt"
    assert store.cloud_relative(user, "/etc") is None
