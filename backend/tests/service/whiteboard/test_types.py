"""Tests for ``service.whiteboard.types`` — the data model.

Most P0 failure modes are about the enum shape: the docs §11.2 promise
that ``audio`` and ``drawing`` are present in ``CaptureType`` from day
one so future capture sources slot in without a migration.
"""

from __future__ import annotations

import pytest

from service.whiteboard.types import (
    CaptureEvent,
    CapturePayload,
    SpotlightItem,
    parse_capture_type,
    parse_view_event_type,
)


def test_capture_type_enum_includes_audio_and_drawing() -> None:
    # If either of these regress out of the enum we silently break the
    # extension hooks — the unit test is the only thing keeping this
    # promise honest until a real audio/drawing PR ships.
    assert parse_capture_type("audio") == "audio"
    assert parse_capture_type("drawing") == "drawing"


def test_capture_type_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        parse_capture_type("hologram")


def test_view_event_type_enum_has_five_kinds() -> None:
    for ev in ("searched", "listed", "read", "injected", "mentioned"):
        assert parse_view_event_type(ev) == ev


def test_view_event_type_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        parse_view_event_type("dreamt")


def test_capture_payload_round_trip() -> None:
    payload = CapturePayload(inline_text="hello")
    again = CapturePayload.from_dict(payload.to_dict())
    assert again.inline_text == "hello"
    assert again.attachment_path is None


def test_capture_payload_is_empty_detects_blank() -> None:
    assert CapturePayload().is_empty() is True
    assert CapturePayload(inline_text="x").is_empty() is False


def test_capture_event_round_trip() -> None:
    event = CaptureEvent(
        capture_id="abc",
        type="screenshot",
        source="screen_capture",
        payload=CapturePayload(attachment_path="_attachments/foo.png"),
        user_id="alice",
    )
    again = CaptureEvent.from_dict(event.to_dict())
    assert again.capture_id == "abc"
    assert again.type == "screenshot"
    assert again.payload.attachment_path == "_attachments/foo.png"
    assert again.user_id == "alice"


def test_spotlight_item_expiration() -> None:
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    expired = SpotlightItem(
        item_id="i",
        user_id="alice",
        session_id=None,
        source_filename="topics/x.md",
        title="x",
        excerpt="",
        expires_at=now - timedelta(minutes=1),
    )
    assert expired.is_expired(now) is True

    pinned = SpotlightItem(
        item_id="i",
        user_id="alice",
        session_id=None,
        source_filename="topics/x.md",
        title="x",
        excerpt="",
        expires_at=now - timedelta(minutes=1),
        pinned=True,
    )
    assert pinned.is_expired(now) is False


def test_spotlight_item_round_trip() -> None:
    item = SpotlightItem(
        item_id="abc",
        user_id="alice",
        session_id="sess-1",
        source_filename="inbox/foo.md",
        title="Foo",
        excerpt="hello",
        attachments=("_attachments/foo.png",),
        capture_id="cap-1",
    )
    again = SpotlightItem.from_dict(item.to_dict())
    assert again.item_id == "abc"
    assert again.attachments == ("_attachments/foo.png",)
    assert again.capture_id == "cap-1"
