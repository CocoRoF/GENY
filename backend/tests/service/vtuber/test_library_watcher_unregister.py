"""library_watcher pass-2 (auto-unregister) must actually remove entries.

Regression for a live prod bug: `_drop_model_with_dir` is async, and the
watcher called it WITHOUT await — the coroutine was never executed, so a
model whose source zip disappeared from the inbox stayed registered and
"auto-unregistered ..." logged again on every scan forever (observed at
one line per 5s interval). The fix awaits the helper; this test pins the
behavior end-to-end through a real `_scan_once` pass.
"""

from __future__ import annotations

import asyncio
import warnings

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI


def _setup(tmp_path, monkeypatch):
    import controller.vtuber_baked_imports_controller as ctl
    import service.sessions.store as store_mod
    import service.vtuber.library_watcher as watcher
    from service.vtuber.live2d_model_manager import Live2dModelInfo, Live2dModelManager

    class _FakeStore:
        def update(self, sid, patch):
            pass

        def get(self, sid):
            return None

    monkeypatch.setattr(store_mod, "get_session_store", lambda: _FakeStore())

    inbox = tmp_path / "inbox"
    inbox.mkdir()
    monkeypatch.setenv("GENY_BAKED_IMPORTS_DIR", str(inbox))

    mmd_root = tmp_path / "static" / "mmd-models"
    monkeypatch.setattr(ctl, "_live2d_models_root", lambda: tmp_path / "static" / "live2d-models")
    monkeypatch.setattr(ctl, "_spine_models_root", lambda: tmp_path / "static" / "spine-models")
    monkeypatch.setattr(ctl, "_mmd_models_root", lambda: mmd_root)

    registry_dir = tmp_path / "registry"
    registry_dir.mkdir()
    manager = Live2dModelManager(str(registry_dir))

    # A registered mmd model whose extracted dir exists but whose source
    # zip is NOT in the (empty) inbox → pass 2 must unregister it.
    model_dir = mmd_root / "chisa__editor_x"
    model_dir.mkdir(parents=True)
    (model_dir / "chisa.pmx").write_bytes(b"PMX fake")
    manager.add_model(
        Live2dModelInfo(
            name="chisa__editor_x",
            display_name="Chisa (Editor)",
            description="",
            url="/static/mmd-models/chisa__editor_x/chisa.pmx",
            thumbnail=None,
            kScale=1.0,
            initialXshift=0,
            initialYshift=0,
            idleMotionGroupName="",
            emotionMap={"neutral": 0},
            tapMotions={},
            runtime="mmd",
            puppet_id="av_GONE",
        )
    )

    app = FastAPI()
    app.state.live2d_model_manager = manager
    return watcher, app, manager, model_dir


def test_zip_gone_entry_is_actually_removed(tmp_path, monkeypatch):
    watcher, app, manager, model_dir = _setup(tmp_path, monkeypatch)

    # A never-awaited coroutine surfaces as RuntimeWarning at GC — turn
    # that into a hard failure so the bug can't silently return.
    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        asyncio.run(watcher._scan_once(app))

    assert manager.get_model("chisa__editor_x") is None, (
        "registry entry survived the unregister pass — _drop_model_with_dir "
        "was probably not awaited"
    )
    assert not model_dir.exists(), "extracted model dir should be removed with the entry"
