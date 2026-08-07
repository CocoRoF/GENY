"""What the sandbox can see — effect-proving tests.

The cloud is one tree: the user's linked folders, every agent's own space,
and the GAPT workspaces. A sandboxed tool reaches it through a single bind
mount, and the bind is chosen when the container is built — so this is where
the "shared working space" either holds or quietly does not.

Two properties:

  · a CONNECTED agent stands INSIDE the shared tree — its own space is the
    working directory, and the user's folders and GAPT workspace are
    addressable from there. That is what makes the cloud shared rather than
    a place the agent posts into blindly;
  · a DISCONNECTED agent sees only its own space, matching the host-side
    tool roots exactly. A bind cannot be re-scoped per turn, so the two
    enforcement points have to agree at build time or the toggle is a lie.
"""

from __future__ import annotations

import os

from service.gapt.provider import GaptSandboxHandle


def _handle(backend_dir: str, host_dir: str) -> GaptSandboxHandle:
    return GaptSandboxHandle(
        client=None,  # unused for path mapping
        workspace_id="ws-1",
        backend_workspace_dir=backend_dir,
        bind_host_dir=host_dir,
    )


CLOUD = "/data/geny_agent_sessions/_cloud/hr/workspace"
HOST = "/home/docker/volumes/geny_x/_data/_cloud/hr/workspace"


def test_a_connected_agent_works_from_its_own_space_inside_the_tree():
    """The bind is the cloud; the working directory is the agent's corner of
    it. Landing at the cloud ROOT instead would make every relative path an
    agent writes end up beside other agents' spaces."""
    h = _handle(CLOUD, HOST)
    assert h.map_path(f"{CLOUD}/agents/sid-1") == "/workspace/agents/sid-1"
    assert h.map_path(f"{CLOUD}/agents/sid-1/report.md") == (
        "/workspace/agents/sid-1/report.md"
    )


def test_a_connected_agent_can_reach_the_shared_parts():
    """A linked folder and the user's GAPT workspace are the whole point of
    a shared space — unmappable means invisible to every sandboxed tool."""
    h = _handle(CLOUD, HOST)
    assert h.map_path(f"{CLOUD}/내문서/plan.md") == "/workspace/내문서/plan.md"
    assert h.map_path(f"{CLOUD}/gapt/build") == "/workspace/gapt/build"
    assert h.map_path(f"{CLOUD}/agents/other-sid/x") == "/workspace/agents/other-sid/x"


def test_the_host_side_path_maps_to_the_same_place():
    """Backend and host name the same bytes through different prefixes. If
    they disagreed, a path handed back by a host-side tool would not resolve
    inside the container."""
    h = _handle(CLOUD, HOST)
    assert h.map_path(f"{HOST}/agents/sid-1/out.txt") == h.map_path(
        f"{CLOUD}/agents/sid-1/out.txt"
    )


def test_a_disconnected_agent_sees_only_itself():
    """THE property behind the connection toggle. Bound to its own space, the
    rest of the cloud is not merely hidden — it is unmappable, so no
    sandboxed command can name it."""
    own = f"{CLOUD}/agents/sid-1"
    h = _handle(own, f"{HOST}/agents/sid-1")
    assert h.map_path(f"{own}/report.md") == "/workspace/report.md"
    assert h.map_path(f"{CLOUD}/내문서/plan.md") is None
    assert h.map_path(f"{CLOUD}/agents/other-sid/x") is None
    assert h.map_path(f"{CLOUD}/gapt/build") is None


def test_nothing_outside_the_cloud_is_reachable_either_way():
    for h in (_handle(CLOUD, HOST), _handle(f"{CLOUD}/agents/sid-1", HOST + "/agents/sid-1")):
        assert h.map_path("/etc/passwd") is None
        assert h.map_path("/data/geny_agent_sessions/other-session/workspace") is None


def test_a_sibling_prefix_is_not_mistaken_for_the_root():
    """`/workspace-backup` starts with the root's characters but is a
    different directory; a bare startswith would map it in."""
    h = _handle(CLOUD, HOST)
    assert h.map_path(CLOUD + "-backup/secret") is None


# ── which root the manager actually picks ───────────────────────────

import pytest  # noqa: E402

from service.cloud import store  # noqa: E402


@pytest.fixture
def cloud(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    return "hr", "sid-1"


def test_connecting_widens_the_bind_to_the_whole_cloud(cloud):
    user, sid = cloud
    store.set_connected(user, sid, True)
    assert store.sandbox_bind_root(user, sid) == store.cloud_workspace(user)


def test_disconnecting_narrows_it_to_the_agents_own_space(cloud):
    user, sid = cloud
    store.set_connected(user, sid, False)
    root = store.sandbox_bind_root(user, sid)
    assert root == store.agent_space(user, sid)
    # And it exists — GAPT validates the host dir before mounting it.
    assert os.path.isdir(root)


def test_the_bind_matches_what_the_host_side_tools_allow(cloud):
    """Two enforcement points, one boundary. If the sandbox were bound wider
    than the tool roots, `Bash` would reach what `Read` refuses — and the
    connection toggle would mean nothing for the sandboxed half."""
    user, sid = cloud
    for connected in (True, False):
        store.set_connected(user, sid, connected)
        root = store.sandbox_bind_root(user, sid)
        widest = store.cloud_workspace(user) if connected else store.agent_space(user, sid)
        assert root == widest
