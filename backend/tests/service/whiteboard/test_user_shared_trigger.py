"""Tests for the [USER_SHARED] trigger prompt composition.

Phase A of the VTuber framing fix: the synthetic prompt the trigger
sends to the agent executor must read differently for *ambient*
overheard audio (V2 STT stream) vs *deliberate* shares (manual
Share-with-VTuber, microphone_record promoted to spotlight).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import pytest

from service.whiteboard.types import SpotlightItem
from service.whiteboard.user_shared_trigger import _compose_trigger_prompt


def _spotlight(
    *,
    title: str = "Audio memo 2026-05-14 02:26:13",
    excerpt: str = "> **Transcript (en):** hello",
    metadata: Optional[Dict[str, Any]] = None,
) -> SpotlightItem:
    return SpotlightItem(
        item_id="item-1",
        user_id="alice",
        session_id="sess-1",
        source_filename="inbox/audio-1.md",
        title=title,
        excerpt=excerpt,
        capture_id="cap-1",
        note_kind="user",
        metadata=metadata or {},
        expires_at=datetime.now(timezone.utc),
    )


def _payload_from(prompt: str) -> Dict[str, Any]:
    """Parse the JSON payload that prefixes the trigger body."""
    first_line = prompt.split("\n", 1)[0]
    assert first_line.startswith("[USER_SHARED] ")
    raw = first_line[len("[USER_SHARED] "):]
    return json.loads(raw)


# ── Ambient (V2 STT stream) framing ──────────────────────────────────


def test_ambient_payload_flags_share_source() -> None:
    item = _spotlight(metadata={"source": "vtuber_stt_stream"})
    prompt = _compose_trigger_prompt(item, seen_before=False)
    payload = _payload_from(prompt)
    assert payload["ambient"] is True
    assert payload["share_source"] == "vtuber_stt_stream"


def test_ambient_body_uses_overheard_framing() -> None:
    item = _spotlight(metadata={"source": "vtuber_stt_stream"})
    prompt = _compose_trigger_prompt(item, seen_before=False)
    # Must NOT use the deliberate-share framing string.
    assert "The user just shared the material above" not in prompt
    # MUST cue the persona that this is ambient / overheard.
    assert "happened to pick up from the mic" in prompt or "overheard" in prompt
    # Must explicitly authorize silence as a valid response.
    assert "staying silent" in prompt


def test_ambient_body_forbids_share_language() -> None:
    """The persona must NOT use "you shared ~ with me" phrasing
    for STT stream captures — those don't match the actual user
    intent (ambient mic, not a deliberate share)."""
    item = _spotlight(metadata={"source": "vtuber_stt_stream"})
    prompt = _compose_trigger_prompt(item, seen_before=False)
    assert "you shared" in prompt and "Never use" in prompt


def test_ambient_body_coalesces_bursts() -> None:
    item = _spotlight(metadata={"source": "vtuber_stt_stream"})
    prompt = _compose_trigger_prompt(item, seen_before=False)
    # Must instruct the persona to consolidate multiple spotlight
    # items in the same burst into one reaction.
    assert "all of them at once" in prompt


# ── Deliberate (manual share, microphone_record) framing ─────────────


def test_deliberate_share_uses_existing_framing() -> None:
    item = _spotlight(metadata={})
    prompt = _compose_trigger_prompt(item, seen_before=False)
    payload = _payload_from(prompt)
    assert payload["ambient"] is False
    assert "The user just shared the material above" in prompt
    # No ambient-specific language sneaks into deliberate framing.
    assert "happened to pick up from the mic" not in prompt


def test_unknown_source_falls_through_to_deliberate() -> None:
    item = _spotlight(metadata={"source": "something_else"})
    prompt = _compose_trigger_prompt(item, seen_before=False)
    payload = _payload_from(prompt)
    assert payload["ambient"] is False
    assert payload["share_source"] == "something_else"
    assert "The user just shared the material above" in prompt


def test_missing_metadata_falls_through_to_deliberate() -> None:
    item = _spotlight(metadata=None)
    prompt = _compose_trigger_prompt(item, seen_before=False)
    payload = _payload_from(prompt)
    assert payload["ambient"] is False
    assert payload["share_source"] == ""


# ── Payload integrity ────────────────────────────────────────────────


def test_existing_payload_fields_remain_intact() -> None:
    """Adding ``ambient`` / ``share_source`` must not change the
    pre-existing payload shape — older skills + tests can still rely
    on title / excerpt / seen_before / kind / source_filename /
    attachments_count."""
    item = _spotlight(metadata={"source": "vtuber_stt_stream"})
    payload = _payload_from(_compose_trigger_prompt(item, seen_before=True))
    for key in (
        "title", "kind", "source_filename", "excerpt",
        "seen_before", "attachments_count",
    ):
        assert key in payload, f"payload missing legacy field {key!r}"
    assert payload["seen_before"] is True


def test_excerpt_truncation_respected_in_both_branches() -> None:
    long_excerpt = "x" * 400
    for source in ("vtuber_stt_stream", "manual"):
        item = _spotlight(
            excerpt=long_excerpt,
            metadata={"source": source},
        )
        payload = _payload_from(_compose_trigger_prompt(item, seen_before=False))
        assert payload["excerpt"].endswith("…")
        assert len(payload["excerpt"]) <= 320
