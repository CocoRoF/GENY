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


def test_the_old_cloud_link_is_dropped_rather_than_carried_in(world):
    """`workspace/cloud` pointed at the cloud root. Moving it into the agent's
    own space — which now lives inside the cloud — would make the space
    contain a link to its own ancestor, and a mount or an explorer walks that
    cycle forever. The link has nothing left to express."""
    user, storage, sid = world
    ws = Path(storage) / "workspace"
    os.symlink(store.cloud_workspace(user), str(ws / "cloud"), target_is_directory=True)
    (ws / "real.txt").write_text("keep me", encoding="utf-8")

    target = Path(store.adopt_agent_space(user, storage, sid))

    assert not (target / "cloud").exists()
    assert not (target / "cloud").is_symlink()
    assert (target / "real.txt").read_text(encoding="utf-8") == "keep me"


def test_an_unrelated_symlink_named_cloud_is_preserved(world):
    """Only the link to the cloud ROOT is ours to remove. Anything else a
    user or agent made under that name is their file."""
    user, storage, sid = world
    other = Path(storage) / "elsewhere"
    other.mkdir()
    os.symlink(str(other), str(Path(storage) / "workspace" / "cloud"), target_is_directory=True)

    target = Path(store.adopt_agent_space(user, storage, sid))

    assert (target / "cloud").is_symlink()


# ── one path, one owner ─────────────────────────────────────────────

def test_an_adopted_session_journals_nothing_of_its_own(world):
    """The bytes live in the cloud and the cloud journal owns them. The
    session's workspace is a symlink, and `os.walk(followlinks=False)` still
    enters the TOP path — so without an explicit check the session journal
    indexed the cloud too and two journals owned the same files."""
    from service.utils.workspace_sync import refresh_index, used_bytes

    user, storage, sid = world
    (Path(storage) / "workspace" / "big.bin").write_bytes(b"x" * 5000)
    store.adopt_agent_space(user, storage, sid)

    refresh_index(storage, sid, force=True)
    assert used_bytes(storage) == 0, "the session journal claimed cloud bytes"

    cloud = store.cloud_storage_path(user)
    refresh_index(cloud, "cloud", force=True)
    assert used_bytes(cloud) >= 5000, "the cloud journal did not pick them up"


def test_usage_is_read_from_the_owning_journal(world):
    """Quota enforcement measures whatever `owning_storage` points at. If an
    adopted agent resolved to its own empty journal the quota would read 0 and
    be switched off for every agent write."""
    from service.utils.workspace_sync import refresh_index, used_bytes, used_bytes_under

    user, storage, sid = world
    (Path(storage) / "workspace" / "payload.bin").write_bytes(b"y" * 4096)
    store.adopt_agent_space(user, storage, sid)
    cloud = store.cloud_storage_path(user)
    refresh_index(cloud, "cloud", force=True)

    owner, prefix = store.owning_storage(storage)

    assert owner == cloud
    assert prefix == f"agents/{sid}"
    assert used_bytes(owner) >= 4096, "quota would not see the agent's bytes"
    assert used_bytes_under(owner, prefix) >= 4096, "per-agent slice is wrong"


def test_a_non_adopted_session_still_owns_its_own_bytes(world):
    """Sessions whose adoption was skipped (no owner, or a failed move) must
    keep being measured where their files actually are."""
    user, storage, sid = world
    (Path(storage) / "workspace" / "local.txt").write_text("still here", encoding="utf-8")

    owner, prefix = store.owning_storage(storage)

    assert owner == storage
    assert prefix == ""


def test_the_owner_is_derived_from_the_link_when_no_user_is_given(world):
    """Quota enforcement has a storage path and no username in hand."""
    user, storage, sid = world
    store.adopt_agent_space(user, storage, sid)

    owner, prefix = store.owning_storage(storage)

    assert owner == store.cloud_storage_path(user)
    assert prefix == f"agents/{sid}"


# ── cleanup and reserved names ──────────────────────────────────────

@pytest.mark.asyncio
async def test_permanent_delete_removes_the_cloud_space(world):
    """rmtree of the session root only removes the SYMLINK. Without this the
    agent's directory stays in the cloud forever under an opaque uuid — and
    replicates to every PC."""
    from service.executor.agent_session_manager import _remove_cloud_agent_space

    user, storage, sid = world
    (Path(storage) / "workspace" / "output.txt").write_text("work", encoding="utf-8")
    target = Path(store.adopt_agent_space(user, storage, sid))
    assert target.is_dir()

    await _remove_cloud_agent_space(user, sid)

    assert not target.exists()


@pytest.mark.asyncio
async def test_cleanup_without_an_owner_is_a_no_op(world):
    """A session whose adoption was skipped has no cloud space to remove, and
    deletion must finish regardless."""
    from service.executor.agent_session_manager import _remove_cloud_agent_space

    await _remove_cloud_agent_space("", "sid-x")
    await _remove_cloud_agent_space("hr", "never-adopted")


def test_reserved_names_cover_the_structure(world):
    """`agents` and `gapt` are the cloud's own layout — a linked folder taking
    either would be mirrored on top of it."""
    user, _storage, _sid = world
    assert "agents" in store.RESERVED_CLOUD_NAMES
    assert "gapt" in store.RESERVED_CLOUD_NAMES
    assert Path(store.agents_root(user)).name == "agents"
    assert Path(store.user_gapt_root(user)).name == "gapt"
