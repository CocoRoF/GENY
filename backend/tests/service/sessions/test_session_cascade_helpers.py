"""Unit tests for the session→cron/task cascade helpers and the owner-stamping
cron store wrapper. These are what make "delete the agent deletes everything it
owns" reliable.
"""

from __future__ import annotations

import asyncio

import pytest

from service.database import session_db_helper as H


class _FakeMgr:
    """Records every execute_update_delete(query, params)."""
    def __init__(self):
        self.calls = []
    def execute_update_delete(self, query, params=None):
        self.calls.append((" ".join(query.split()), params))
        return 1


@pytest.fixture(autouse=True)
def _db_available(monkeypatch):
    monkeypatch.setattr(H, "_is_db_available", lambda db: True)
    monkeypatch.setattr(H, "_get_db_manager", lambda db: db)


def test_delete_tasks_by_session_targets_outputs_then_tasks():
    mgr = _FakeMgr()
    n = H.db_delete_tasks_by_session(mgr, "SID")
    assert n == 1
    q0, p0 = mgr.calls[0]
    q1, p1 = mgr.calls[1]
    # outputs deleted via the tasks subquery, then the tasks themselves.
    assert "background_task_outputs" in q0 and "background_tasks" in q0
    assert q1.startswith("DELETE FROM background_tasks WHERE")
    # probes both spaced and compact JSON for _session_id.
    assert any('"_session_id": "SID"' in str(x) for x in p1)
    assert any('"_session_id":"SID"' in str(x) for x in p1)


def test_delete_crons_by_session_matches_owner_and_legacy_target():
    mgr = _FakeMgr()
    H.db_delete_crons_by_session(mgr, "SID")
    q, params = mgr.calls[0]
    assert q.startswith("DELETE FROM cron_jobs WHERE")
    joined = " ".join(str(x) for x in params)
    assert '"_session_id": "SID"' in joined   # owner (new crons)
    assert '"session_id": "SID"' in joined     # legacy / self-target crons


def test_helpers_are_noops_without_db(monkeypatch):
    monkeypatch.setattr(H, "_is_db_available", lambda db: False)
    assert H.db_delete_tasks_by_session(object(), "S") == 0
    assert H.db_delete_crons_by_session(object(), "S") == 0


def test_scoped_cron_store_stamps_owner():
    from service.executor.agent_session import _SessionScopedCronStore

    class _Job:
        def __init__(self, payload):
            self.payload = payload

    class _Inner:
        def __init__(self):
            self.put_jobs = []
        async def put(self, job):
            self.put_jobs.append(job)
            return "ok"
        async def get(self, name):  # passthrough proof
            return f"got:{name}"

    inner = _Inner()
    store = _SessionScopedCronStore(inner, "SESS-1")

    job = _Job({"message": "안녕"})
    assert asyncio.get_event_loop().run_until_complete(store.put(job)) == "ok"
    # owner stamped into the created cron's payload
    assert job.payload["_session_id"] == "SESS-1"
    # non-put methods pass straight through
    assert asyncio.get_event_loop().run_until_complete(store.get("j")) == "got:j"


def test_scoped_cron_store_does_not_clobber_existing_session():
    from service.executor.agent_session import _SessionScopedCronStore

    class _Job:
        payload = {"_session_id": "ORIGINAL"}

    class _Inner:
        async def put(self, job):
            return "ok"

    job = _Job()
    asyncio.get_event_loop().run_until_complete(
        _SessionScopedCronStore(_Inner(), "SESS-2").put(job))
    # setdefault: an already-stamped owner is preserved.
    assert job.payload["_session_id"] == "ORIGINAL"
