"""Avatar model assignment must survive a backend restart / session reload.

Before this, assignments lived ONLY in Live2dModelManager._agent_assignments
(in-memory) and model_registry.json is regenerated from baked-imports on every
restart — so a redeploy dropped the binding and the VTuber tab showed
"할당된 모델이 없습니다". Now assign writes a durable record to the session store
and get_agent_model_name() restores from it when the in-memory cache is cold.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pydantic")


class _FakeStore:
    def __init__(self):
        self.records: dict = {}

    def update(self, sid, patch):
        self.records.setdefault(sid, {}).update(patch)

    def get(self, sid):
        return self.records.get(sid)


def _manager(tmp_path, monkeypatch):
    import service.sessions.store as store_mod
    from service.vtuber.live2d_model_manager import Live2dModelManager

    fake = _FakeStore()
    monkeypatch.setattr(store_mod, "get_session_store", lambda: fake)
    mgr = Live2dModelManager(str(tmp_path))
    mgr._models = {"m1": object()}  # bypass registry file; one known model
    return mgr, fake


def test_assign_writes_durable_session_record(tmp_path, monkeypatch):
    mgr, fake = _manager(tmp_path, monkeypatch)
    mgr.assign_model_to_agent("s1", "m1")
    assert fake.records["s1"]["assigned_model"] == "m1"
    assert mgr.get_agent_model_name("s1") == "m1"


def test_restores_from_store_after_inmemory_loss(tmp_path, monkeypatch):
    mgr, fake = _manager(tmp_path, monkeypatch)
    mgr.assign_model_to_agent("s1", "m1")
    # Simulate a restart: the in-memory registry binding is gone.
    mgr._agent_assignments.clear()
    assert mgr.get_agent_model_name("s1") == "m1"   # restored from session store
    assert mgr._agent_assignments["s1"] == "m1"     # re-cached for subsequent reads


def test_unassign_clears_store(tmp_path, monkeypatch):
    mgr, fake = _manager(tmp_path, monkeypatch)
    mgr.assign_model_to_agent("s1", "m1")
    mgr.unassign_model("s1")
    assert fake.records["s1"]["assigned_model"] is None
    assert mgr.get_agent_model_name("s1") is None


def test_unknown_stored_model_is_ignored(tmp_path, monkeypatch):
    mgr, fake = _manager(tmp_path, monkeypatch)
    # Store points at a model that no longer exists in the registry.
    fake.records["s1"] = {"assigned_model": "deleted-model"}
    assert mgr.get_agent_model_name("s1") is None


def test_assign_and_unassign_notify_subscribers(tmp_path, monkeypatch):
    # The live sync stream depends on assign/unassign waking subscribers with
    # the exact (session_id, model_name|None) change.
    mgr, _fake = _manager(tmp_path, monkeypatch)
    q = mgr.subscribe_assignment_changes()
    try:
        mgr.assign_model_to_agent("s1", "m1")
        assert q.get_nowait() == ("s1", "m1")
        mgr.unassign_model("s1")
        assert q.get_nowait() == ("s1", None)
    finally:
        mgr.unsubscribe_assignment_changes(q)
