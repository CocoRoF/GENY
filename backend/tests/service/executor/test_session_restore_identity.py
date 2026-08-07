"""What a session keeps across a restart — effect-proving tests.

A restored session is rebuilt from its stored record, and anything the record
does not carry is silently lost. Two things were:

  · the OWNER. Without it the session has no cloud identity at all — its
    space is never adopted, its sandbox binds the legacy path instead of the
    shared tree, and quota reads an empty journal and switches off. This is
    the same shape of bug the `env_id` comment in the store already warns
    about, one field over.
  · the WORKING DIRECTORY. The record echoes `storage_path` back as
    `working_dir`, and adoption steps aside for any caller-supplied
    `working_dir` — so the same agent worked in its cloud space when created
    and in the session root after a restart. (That one is asserted end-to-end
    in test_session_lazy_restore.py, which drives `_rehydrate` itself.)

Neither failed loudly. Both change where an agent's files go.
"""

from __future__ import annotations

import pytest

from service.cloud import store


@pytest.fixture
def adopted(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    storage = tmp_path / "sessions" / "sid-1"
    (storage / "workspace").mkdir(parents=True)
    store.adopt_agent_space("hr", str(storage), "sid-1")
    return str(storage)


def test_the_owner_is_handed_back_for_a_restart(tmp_path):
    """`get_creation_params` is the whole of what a restart knows. A field
    missing here is a field the rebuilt session does not have."""
    from service.sessions.store import SessionStore

    st = SessionStore(path=tmp_path / "sessions.json")
    st.register("sid-1", {
        "session_id": "sid-1",
        "session_name": "ellen",
        "storage_path": "/data/sessions/sid-1",
        "owner_username": "hr",
        "role": "vtuber",
    })

    params = st.get_creation_params("sid-1")

    assert params is not None
    assert params.get("owner_username") == "hr", (
        "the owner never reaches the restart — the session loses its cloud "
        "identity every time it wakes"
    )


def test_an_adopted_session_can_name_its_owner_without_the_record(adopted):
    """Records written before the owner was carried through hold None. The
    adoption symlink already knows, so those sessions heal instead of
    needing a migration."""
    assert store.owner_of_storage(adopted) == "hr"


def test_a_session_outside_the_cloud_claims_no_owner(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    loose = tmp_path / "loose"
    (loose / "workspace").mkdir(parents=True)
    assert store.owner_of_storage(str(loose)) == ""


def test_a_dangling_link_does_not_invent_an_owner(tmp_path, monkeypatch):
    """A link pointing outside the cloud must not have its first path
    component read as a username."""
    import os

    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    storage = tmp_path / "s2"
    storage.mkdir()
    os.symlink(str(tmp_path / "elsewhere"), str(storage / "workspace"),
               target_is_directory=True)
    assert store.owner_of_storage(str(storage)) == ""

