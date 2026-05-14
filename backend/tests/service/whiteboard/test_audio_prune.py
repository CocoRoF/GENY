"""Tests for the audio inbox noise pruner."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest


# ── is_noise_transcript ──────────────────────────────────────────────


@pytest.mark.parametrize("text", [
    None,
    "",
    "   ",
    "\n\n",
    "-",
    ".",
    "...",
    "..?",
    "?!",
    "  -  ",
])
def test_noise_predicate_true_for_garbage(text: Optional[str]) -> None:
    from service.whiteboard.audio_prune import is_noise_transcript
    assert is_noise_transcript(text) is True


@pytest.mark.parametrize("text", [
    "Okay.",
    "안녕",
    "hello",
    "Yes!",
    "네 알겠습니다.",
    "Mm-hmm — go ahead.",
    "AB",
])
def test_noise_predicate_false_for_real_speech(text: str) -> None:
    from service.whiteboard.audio_prune import is_noise_transcript
    assert is_noise_transcript(text) is False


def test_noise_predicate_duration_floor() -> None:
    """Sub-400 ms clips are pruned even with meaningful text — those
    are VAD misfires that happened to coincide with a single word."""
    from service.whiteboard.audio_prune import is_noise_transcript
    assert is_noise_transcript("Yes", duration_seconds=0.2) is True
    assert is_noise_transcript("Yes", duration_seconds=0.4) is False
    assert is_noise_transcript("Yes", duration_seconds=None) is False


def test_noise_predicate_zero_duration_is_ignored() -> None:
    """vLLM returns ``duration_seconds=0.0`` when it can't measure;
    treat that as "unknown duration" rather than "below the floor"."""
    from service.whiteboard.audio_prune import is_noise_transcript
    assert is_noise_transcript("Hello there", duration_seconds=0.0) is False


# ── extract_existing_transcript ──────────────────────────────────────


def test_extract_transcript_simple() -> None:
    from service.whiteboard.audio_prune import extract_existing_transcript
    body = "> **Transcript (en):** hello world\n\n![[voice.webm]]\n"
    assert extract_existing_transcript(body) == "hello world"


def test_extract_transcript_korean() -> None:
    from service.whiteboard.audio_prune import extract_existing_transcript
    body = "> **Transcript (ko):** 안녕하세요 반가워요\n\n뒷부분"
    assert extract_existing_transcript(body) == "안녕하세요 반가워요"


def test_extract_transcript_auto_lang() -> None:
    from service.whiteboard.audio_prune import extract_existing_transcript
    body = "> **Transcript (auto):** -\n\n![[voice.webm]]"
    assert extract_existing_transcript(body) == "-"


def test_extract_transcript_absent() -> None:
    from service.whiteboard.audio_prune import extract_existing_transcript
    assert extract_existing_transcript("just plain body") is None
    assert extract_existing_transcript("") is None
    assert extract_existing_transcript(
        "> some other quote\n\nbody"
    ) is None


# ── should_prune_for_source ──────────────────────────────────────────


def test_only_vtuber_stt_stream_is_prunable() -> None:
    from service.whiteboard.audio_prune import should_prune_for_source
    assert should_prune_for_source("vtuber_stt_stream") is True
    assert should_prune_for_source("microphone_record") is False
    assert should_prune_for_source("file_drop") is False
    assert should_prune_for_source("manual") is False
    assert should_prune_for_source(None) is False
    assert should_prune_for_source("") is False


# ── prune_audio_note ─────────────────────────────────────────────────


class _StubMgr:
    def __init__(self, *, note_delete_returns: bool = True) -> None:
        self._note_delete_returns = note_delete_returns
        self.deleted_notes: List[str] = []
        self.deleted_attachments: List[str] = []

    def delete_note(self, filename: str) -> bool:
        self.deleted_notes.append(filename)
        return self._note_delete_returns

    def delete_attachment(self, path: str) -> bool:
        self.deleted_attachments.append(path)
        return True


def test_prune_deletes_note_and_attachment() -> None:
    from service.whiteboard.audio_prune import prune_audio_note
    mgr = _StubMgr()
    ok = prune_audio_note(
        mgr, "inbox/audio-1.md", "_attachments/voice.webm",
    )
    assert ok is True
    assert mgr.deleted_notes == ["inbox/audio-1.md"]
    assert mgr.deleted_attachments == ["_attachments/voice.webm"]


def test_prune_tolerates_attachment_failure() -> None:
    """A failed attachment delete shouldn't unwind the note delete —
    leaving a half-deleted note is worse than a stray binary."""
    from service.whiteboard.audio_prune import prune_audio_note

    class _PartialMgr(_StubMgr):
        def delete_attachment(self, path: str) -> bool:
            raise RuntimeError("disk full")

    mgr = _PartialMgr()
    ok = prune_audio_note(
        mgr, "inbox/audio-1.md", "_attachments/voice.webm",
    )
    assert ok is True
    assert mgr.deleted_notes == ["inbox/audio-1.md"]


def test_prune_returns_false_when_note_delete_fails() -> None:
    from service.whiteboard.audio_prune import prune_audio_note
    mgr = _StubMgr(note_delete_returns=False)
    ok = prune_audio_note(
        mgr, "inbox/audio-1.md", "_attachments/voice.webm",
    )
    assert ok is False


def test_prune_handles_missing_attachment_path() -> None:
    from service.whiteboard.audio_prune import prune_audio_note
    mgr = _StubMgr()
    ok = prune_audio_note(mgr, "inbox/audio-1.md", None)
    assert ok is True
    assert mgr.deleted_attachments == []


# ── Integration: _backfill_one_note prune branches ───────────────────


class _BackfillMgr:
    def __init__(
        self,
        *,
        notes: Dict[str, Dict[str, Any]],
        attachments: Dict[str, Optional[bytes]],
    ) -> None:
        self._notes = dict(notes)
        self._attachments = dict(attachments)
        self.updates: List[tuple[str, str]] = []
        self.deleted_notes: List[str] = []
        self.deleted_attachments: List[str] = []

    def read_note(self, filename: str) -> Optional[Dict[str, Any]]:
        n = self._notes.get(filename)
        return dict(n) if n else None

    def read_attachment(self, path: str) -> Optional[bytes]:
        return self._attachments.get(path)

    def update_note(self, filename: str, *, body: str) -> bool:
        if filename not in self._notes:
            return False
        self._notes[filename]["body"] = body
        self.updates.append((filename, body))
        return True

    def delete_note(self, filename: str) -> bool:
        if filename in self._notes:
            del self._notes[filename]
            self.deleted_notes.append(filename)
            return True
        return False

    def delete_attachment(self, path: str) -> bool:
        if path in self._attachments:
            del self._attachments[path]
            self.deleted_attachments.append(path)
            return True
        return False


def _install_stubs(
    monkeypatch: pytest.MonkeyPatch,
    *,
    mgr: _BackfillMgr,
    text: str = "hello world",
    duration: float = 1.5,
    source: str = "whisper",
) -> None:
    from service.memory import user_opsidian as user_opsidian_mod
    from service.stt import whisper_client as wc_mod
    from service.stt.whisper_client import TranscriptionResult

    monkeypatch.setattr(
        user_opsidian_mod, "get_user_opsidian_manager", lambda _u: mgr,
    )

    fixture_text = text
    fixture_duration = duration
    fixture_source = source

    class _StubClient:
        async def atranscribe(
            self, audio_bytes: bytes, *, filename: str = "audio.webm",
            language: Optional[str] = None,
        ) -> TranscriptionResult:
            return TranscriptionResult(
                text=fixture_text,
                language="en",
                duration_seconds=fixture_duration,
                source=fixture_source,
            )

    monkeypatch.setattr(wc_mod, "get_whisper_client", lambda: _StubClient())


def _run(coro):
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _entry(*, source: str = "vtuber_stt_stream") -> "object":
    from service.whiteboard.audio_backfill import _CaptureLogEntry
    return _CaptureLogEntry(
        capture_id="cap-1",
        draft_note="inbox/audio-1.md",
        attachment_path="_attachments/voice.webm",
        source=source,
    )


def test_backfill_prunes_fresh_noise_from_stt_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import _backfill_one_note

    mgr = _BackfillMgr(
        notes={"inbox/audio-1.md": {"body": "![[voice.webm]]\n"}},
        attachments={"_attachments/voice.webm": b"FAKEWEBM"},
    )
    _install_stubs(monkeypatch, mgr=mgr, text="-", duration=0.2)

    outcome = _run(_backfill_one_note("alice", _entry()))

    assert outcome.status == "pruned"
    assert mgr.deleted_notes == ["inbox/audio-1.md"]
    assert mgr.deleted_attachments == ["_attachments/voice.webm"]
    assert mgr.updates == []  # no body update


def test_backfill_keeps_real_speech_from_stt_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import _backfill_one_note

    mgr = _BackfillMgr(
        notes={"inbox/audio-1.md": {"body": "![[voice.webm]]\n"}},
        attachments={"_attachments/voice.webm": b"FAKEWEBM"},
    )
    _install_stubs(
        monkeypatch, mgr=mgr, text="안녕하세요 반가워요", duration=2.5,
    )

    outcome = _run(_backfill_one_note("alice", _entry()))

    assert outcome.status == "filled"
    assert mgr.deleted_notes == []
    assert len(mgr.updates) == 1
    assert "안녕하세요 반가워요" in mgr.updates[0][1]


def test_backfill_never_prunes_manual_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Manual ``microphone_record`` captures stay even with noisy text."""
    from service.whiteboard.audio_backfill import _backfill_one_note

    mgr = _BackfillMgr(
        notes={"inbox/audio-1.md": {"body": "![[voice.webm]]\n"}},
        attachments={"_attachments/voice.webm": b"FAKEWEBM"},
    )
    _install_stubs(monkeypatch, mgr=mgr, text="-", duration=0.2)

    outcome = _run(
        _backfill_one_note("alice", _entry(source="microphone_record"))
    )

    # Noise text from a user-clicked record is still surfaced as
    # filled. We don't lose user intent on a Whisper mis-segment.
    assert outcome.status == "filled"
    assert mgr.deleted_notes == []
    assert len(mgr.updates) == 1


def test_backfill_retroactively_prunes_existing_noise_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Notes filled before the pruner shipped that hold a noisy
    transcript get pruned on the next scan."""
    from service.whiteboard.audio_backfill import _backfill_one_note

    mgr = _BackfillMgr(
        notes={"inbox/audio-1.md": {
            "body": "> **Transcript (auto):** -\n\n![[voice.webm]]\n"
        }},
        attachments={"_attachments/voice.webm": b"FAKEWEBM"},
    )
    # Whisper won't actually be called on this branch — the body
    # already has a transcript. Install a stub anyway so the import
    # path in _backfill_one_note is satisfied.
    _install_stubs(monkeypatch, mgr=mgr)

    outcome = _run(_backfill_one_note("alice", _entry()))

    assert outcome.status == "pruned"
    assert mgr.deleted_notes == ["inbox/audio-1.md"]
    assert outcome.reason and "existing fill" in outcome.reason


def test_backfill_keeps_existing_real_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.whiteboard.audio_backfill import _backfill_one_note

    mgr = _BackfillMgr(
        notes={"inbox/audio-1.md": {
            "body": (
                "> **Transcript (ko):** 회의 내용 정리해놓을게요\n\n"
                "![[voice.webm]]\n"
            )
        }},
        attachments={"_attachments/voice.webm": b"FAKEWEBM"},
    )
    _install_stubs(monkeypatch, mgr=mgr)

    outcome = _run(_backfill_one_note("alice", _entry()))

    assert outcome.status == "skipped"
    assert mgr.deleted_notes == []
