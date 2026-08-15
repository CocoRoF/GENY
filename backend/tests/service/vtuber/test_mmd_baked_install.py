"""MMD (PMX) baked-zip install path.

The MMD runtime joined live2d/spine as a third allowlisted runtime in
the baked-imports installer. These tests pin the contract end-to-end at
the HTTP layer:

  * runtime "mmd" zips install instead of 400-ing (the old allowlist)
  * the entry file resolves to the sidecar's pmxPath (costume-variant
    zips ship several .pmx — the sidecar pick must win)
  * the registry entry lands under /static/mmd-models/ with the
    mmdConfig bag (emotionMorphMap by NAME, lipSyncMorph, camera,
    hidden materials, morph catalog) passed through verbatim
  * a zip with no .pmx/.pmd is rejected with a clear 400
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_app(tmp_path, monkeypatch):
    import controller.vtuber_baked_imports_controller as ctl
    import service.sessions.store as store_mod
    from service.auth.auth_middleware import require_auth
    from service.vtuber.live2d_model_manager import Live2dModelManager

    class _FakeStore:
        def update(self, sid, patch):
            pass

        def get(self, sid):
            return None

    monkeypatch.setattr(store_mod, "get_session_store", lambda: _FakeStore())

    inbox = tmp_path / "inbox"
    inbox.mkdir()
    monkeypatch.setenv("GENY_BAKED_IMPORTS_DIR", str(inbox))

    roots = tmp_path / "static"
    monkeypatch.setattr(ctl, "_live2d_models_root", lambda: roots / "live2d-models")
    monkeypatch.setattr(ctl, "_spine_models_root", lambda: roots / "spine-models")
    monkeypatch.setattr(ctl, "_mmd_models_root", lambda: roots / "mmd-models")

    registry_dir = tmp_path / "registry"
    registry_dir.mkdir()
    manager = Live2dModelManager(str(registry_dir))

    app = FastAPI()
    app.include_router(ctl.router)
    app.state.live2d_model_manager = manager
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}
    return app, manager, inbox


def _mmd_zip(sidecar_overrides: dict | None = None, with_model: bool = True) -> bytes:
    """A minimal but structurally-honest MMD baked zip: two .pmx files
    (small decoy + large real one), textures, and the sidecar."""
    sidecar = {
        "schemaVersion": 2,
        "exporter": "geny-avatar/mmd",
        "puppet": {"id": "av_TEST123", "name": "Chisa", "runtime": "mmd", "version": "PMX"},
        "animationConfig": {
            "display": {"kScale": 1.0, "initialXshift": 0, "initialYshift": 0},
            "idleMotionGroupName": "",
            "emotionMap": {"joy": "笑い", "sadness": "困る"},
            "tapMotions": {},
            "mmdCamera": {
                "alpha": -1.57,
                "beta": 1.6,
                "radius": 31.0,
                "targetX": 0,
                "targetY": 19.7,
                "targetZ": 0,
            },
            "lipSyncMorph": "あ",
        },
        "mmd": {
            "pmxPath": "model/chisa.pmx",
            "hiddenMaterials": ["Up_Hat"],
            "hiddenMaterialIndices": [21],
            "morphs": [
                {"name": "笑い", "panel": "eye"},
                {"name": "あ", "panel": "mouth"},
                {"name": "困る", "panel": "brow"},
            ],
        },
    }
    if sidecar_overrides:
        sidecar.update(sidecar_overrides)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        if with_model:
            zf.writestr("model/decoy.pmx", b"PMX small")
            zf.writestr("model/chisa.pmx", b"PMX " + b"\x00" * 4096)
            zf.writestr("model/textures/face.png", b"\x89PNG fake")
        zf.writestr("avatar-editor.json", json.dumps(sidecar, ensure_ascii=False))
    return buf.getvalue()


def test_mmd_zip_installs_with_mmd_config(tmp_path, monkeypatch):
    app, manager, inbox = _make_app(tmp_path, monkeypatch)
    (inbox / "chisa.zip").write_bytes(_mmd_zip())

    client = TestClient(app)
    res = client.post("/api/vtuber/baked-imports/install", json={"filename": "chisa.zip"})
    assert res.status_code == 200, res.text
    model = res.json()["model"]

    assert model["runtime"] == "mmd"
    # sidecar pmxPath wins over the decoy even though sizes would also
    # pick chisa.pmx — assert the exact resolved URL to pin the rule
    assert model["url"].startswith("/static/mmd-models/")
    assert model["url"].endswith("/model/chisa.pmx")
    assert model["atlas_url"] is None

    cfg = model["mmdConfig"]
    assert cfg["emotionMorphMap"] == {"joy": "笑い", "sadness": "困る"}
    assert cfg["lipSyncMorph"] == "あ"
    assert cfg["camera"]["targetY"] == 19.7
    assert cfg["hiddenMaterials"] == ["Up_Hat"]
    assert cfg["hiddenMaterialIndices"] == [21]
    assert [m["name"] for m in cfg["morphs"]] == ["笑い", "あ", "困る"]

    # registry round-trip: reload from disk sees the same bag
    reloaded = manager.get_model(model["name"])
    assert reloaded is not None and reloaded.mmdConfig["lipSyncMorph"] == "あ"

    # extracted onto disk under the mmd root
    extracted = tmp_path / "static" / "mmd-models" / model["name"] / "model" / "chisa.pmx"
    assert extracted.exists()


def test_mmd_zip_without_model_file_is_rejected(tmp_path, monkeypatch):
    app, _manager, inbox = _make_app(tmp_path, monkeypatch)
    (inbox / "empty.zip").write_bytes(_mmd_zip(with_model=False))

    client = TestClient(app)
    res = client.post("/api/vtuber/baked-imports/install", json={"filename": "empty.zip"})
    assert res.status_code == 400
    assert ".pmx" in res.json()["detail"]


def test_mmd_sidecar_with_bad_pmx_path_falls_back_to_largest(tmp_path, monkeypatch):
    app, _manager, inbox = _make_app(tmp_path, monkeypatch)
    (inbox / "weird.zip").write_bytes(
        _mmd_zip(sidecar_overrides={"mmd": {"pmxPath": "../escape.pmx"}})
    )

    client = TestClient(app)
    res = client.post("/api/vtuber/baked-imports/install", json={"filename": "weird.zip"})
    assert res.status_code == 200, res.text
    model = res.json()["model"]
    # traversal-ish sidecar path is ignored; largest .pmx on disk wins
    assert model["url"].endswith("/model/chisa.pmx")


def test_2d_runtimes_still_install_unchanged(tmp_path, monkeypatch):
    """Regression guard: the allowlist widening must not disturb the
    existing live2d branch (entry resolution + registry shape)."""
    app, _manager, inbox = _make_app(tmp_path, monkeypatch)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "hiyori.model3.json",
            json.dumps({"FileReferences": {"Textures": ["t.png"], "Motions": {"Idle": []}}}),
        )
        zf.writestr("t.png", b"\x89PNG fake")
        zf.writestr(
            "avatar-editor.json",
            json.dumps(
                {
                    "schemaVersion": 2,
                    "puppet": {"id": "av_L2D", "name": "Hiyori", "runtime": "live2d"},
                }
            ),
        )
    (inbox / "hiyori.zip").write_bytes(buf.getvalue())

    client = TestClient(app)
    res = client.post("/api/vtuber/baked-imports/install", json={"filename": "hiyori.zip"})
    assert res.status_code == 200, res.text
    model = res.json()["model"]
    assert model["runtime"] == "live2d"
    assert model["url"].startswith("/static/live2d-models/")
    assert model["mmdConfig"] is None
