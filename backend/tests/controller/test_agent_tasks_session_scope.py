"""Audit 2026-06-18 (GAP E) — per-session scoping of the 작업(Tasks) tab.

The task registry is global; isolation is enforced in the controller by the
``_session_id`` stamped into each task's payload. A session only sees its own
tasks (plus its linked Sub-Worker's, for a VTuber).
"""

from __future__ import annotations

import types

import pytest

import controller.agent_tasks_controller as tc


class _Rec:
    def __init__(self, task_id, session_id, kind="local_bash"):
        self.task_id = task_id
        self.kind = kind
        self.status = types.SimpleNamespace(value="done")
        self.created_at = None
        self.started_at = None
        self.completed_at = None
        self.error = None
        self.payload = {"_session_id": session_id} if session_id else {}
        self.output_path = None


class _Registry:
    def __init__(self, recs):
        self._recs = recs

    def list_filtered(self, _filter):
        return list(self._recs)

    def get(self, task_id):
        return next((r for r in self._recs if r.task_id == task_id), None)


def _request(recs):
    state = types.SimpleNamespace(task_registry=_Registry(recs), task_runner=object())
    app = types.SimpleNamespace(state=state)
    return types.SimpleNamespace(app=app)


def test_row_session_id():
    assert tc._row_session_id(_Rec("t1", "sA")) == "sA"
    assert tc._row_session_id(_Rec("t2", None)) is None


def test_session_scope_self_only(monkeypatch):
    # No store / no link → just the session itself.
    monkeypatch.setattr(
        "service.sessions.get_session_store",
        lambda: types.SimpleNamespace(get=lambda _sid: {"linked_session_id": None}),
    )
    assert tc._session_scope("sA", include_linked=True) == {"sA"}


def test_session_scope_includes_linked(monkeypatch):
    monkeypatch.setattr(
        "service.sessions.get_session_store",
        lambda: types.SimpleNamespace(get=lambda _sid: {"linked_session_id": "sub1"}),
    )
    assert tc._session_scope("vtuber1", include_linked=True) == {"vtuber1", "sub1"}
    # include_linked=False → self only
    assert tc._session_scope("vtuber1", include_linked=False) == {"vtuber1"}


@pytest.mark.asyncio
async def test_list_tasks_filters_to_session(monkeypatch):
    monkeypatch.setattr(
        "service.sessions.get_session_store",
        lambda: types.SimpleNamespace(get=lambda _sid: {"linked_session_id": None}),
    )
    recs = [_Rec("t1", "sA"), _Rec("t2", "sB"), _Rec("t3", "sA")]
    resp = await tc.list_tasks(
        request=_request(recs),
        session_id="sA",
        status=None,
        kind=None,
        limit=20,
        include_linked=True,
        _auth={},
    )
    ids = {t.task_id for t in resp.tasks}
    assert ids == {"t1", "t3"}  # sB's task excluded


@pytest.mark.asyncio
async def test_list_tasks_includes_linked_subworker(monkeypatch):
    monkeypatch.setattr(
        "service.sessions.get_session_store",
        lambda: types.SimpleNamespace(get=lambda _sid: {"linked_session_id": "sub1"}),
    )
    recs = [_Rec("t1", "vtuber1"), _Rec("t2", "sub1"), _Rec("t3", "other")]
    resp = await tc.list_tasks(
        request=_request(recs),
        session_id="vtuber1",
        status=None,
        kind=None,
        limit=20,
        include_linked=True,
        _auth={},
    )
    ids = {t.task_id for t in resp.tasks}
    assert ids == {"t1", "t2"}  # vtuber + linked sub, not 'other'


@pytest.mark.asyncio
async def test_get_task_blocks_cross_session(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(
        "service.sessions.get_session_store",
        lambda: types.SimpleNamespace(get=lambda _sid: {"linked_session_id": None}),
    )
    recs = [_Rec("t1", "sB")]
    with pytest.raises(HTTPException) as ei:
        await tc.get_task(request=_request(recs), session_id="sA", task_id="t1", _auth={})
    assert ei.value.status_code == 404
