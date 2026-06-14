"""Broadcast-attachment handling for VTuber screen-observation frames.

Auto-captured screen frames (source="screen_observation") are ambient
context, not user content: they must be (a) excluded from persisted chat
history (no raw base64 bloat) and (b) dropped before reaching the executor
when the screen-image kill-switch is off — while user uploads pass through.
"""

from __future__ import annotations

import pytest

from controller.chat_controller import (
    _attachments_for_storage,
    _filter_observation_frames_for_send,
)


_USER_UPLOAD = {"kind": "image", "url": "file:///x/a.png", "attachment_id": "abc"}
_SCREEN = {
    "kind": "image",
    "mime_type": "image/jpeg",
    "data": "BIGBASE64==",
    "name": "screen.jpg",
    "source": "screen_observation",
}


def test_storage_excludes_screen_frames_keeps_uploads() -> None:
    out = _attachments_for_storage([_USER_UPLOAD, _SCREEN])
    assert out == [_USER_UPLOAD]  # screen frame (raw base64) not persisted


def test_storage_none_when_only_screen_frames() -> None:
    assert _attachments_for_storage([_SCREEN]) is None
    assert _attachments_for_storage(None) is None


def test_send_keeps_screen_frames_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GENY_SCREEN_OBS_SEND_IMAGE", raising=False)  # default ON
    out = _filter_observation_frames_for_send([_USER_UPLOAD, _SCREEN])
    assert out == [_USER_UPLOAD, _SCREEN]


def test_send_drops_screen_frames_when_killswitch_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GENY_SCREEN_OBS_SEND_IMAGE", "0")
    out = _filter_observation_frames_for_send([_USER_UPLOAD, _SCREEN])
    assert out == [_USER_UPLOAD]  # observation frame dropped, upload kept


def test_send_killswitch_off_only_screen_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GENY_SCREEN_OBS_SEND_IMAGE", "false")
    assert _filter_observation_frames_for_send([_SCREEN]) is None
