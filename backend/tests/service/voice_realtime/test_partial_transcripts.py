"""Streaming partial (live-caption) transcripts.

Pins the LocalAgreement stable-prefix logic (text seen in two consecutive
interims is settled → rendered solid so the caption doesn't flicker), the
per-connection ``partials`` toggle, and the on-by-default config.
"""

from __future__ import annotations

from service.voice_realtime.session import _stable_prefix_chars
from service.voice_realtime import config as cfg


# ── stable-prefix (LocalAgreement-2) ─────────────────────────────────

def test_stable_prefix_common_word_run():
    # "서버 상태" appeared in both → those chars are settled; "좀" is new.
    assert _stable_prefix_chars("서버 상태", "서버 상태 좀") == len("서버 상태")


def test_stable_prefix_diverges_at_second_word():
    assert _stable_prefix_chars("서버 상태", "서버 접속") == len("서버")


def test_stable_prefix_empty_prev_is_zero():
    assert _stable_prefix_chars("", "서버") == 0
    assert _stable_prefix_chars("서버", "") == 0


def test_stable_prefix_word_granular_not_char():
    # "안녕" vs "안녕하세요" — different single words, no common word-prefix,
    # so nothing is committed (avoids marking a half-word stable).
    assert _stable_prefix_chars("안녕", "안녕하세요") == 0


def test_stable_prefix_full_match():
    assert _stable_prefix_chars("a b c", "a b c") == len("a b c")
    assert _stable_prefix_chars("a b c", "a b x") == len("a b")


# ── config ───────────────────────────────────────────────────────────

def test_partials_on_by_default(monkeypatch):
    monkeypatch.delenv("GENY_RT_PARTIAL_TRANSCRIPTS", raising=False)
    assert cfg.partial_transcripts_enabled() is True


def test_partials_env_can_disable(monkeypatch):
    monkeypatch.setenv("GENY_RT_PARTIAL_TRANSCRIPTS", "0")
    assert cfg.partial_transcripts_enabled() is False


def test_partial_window_bounds_gpu(monkeypatch):
    monkeypatch.delenv("GENY_RT_PARTIAL_WINDOW_MS", raising=False)
    assert cfg.partial_window_ms() == 12000  # bounded window, not whole utterance


# ── per-connection toggle ────────────────────────────────────────────

def test_session_partials_toggle_via_configure():
    from service.voice_realtime.session import RealtimeVoiceSession

    async def _emit(evt, data):  # unused
        return None

    s = RealtimeVoiceSession("sid", _emit)
    default = s._partials_enabled  # noqa: SLF001
    s.configure(partials=not default)
    assert s._partials_enabled is (not default)  # noqa: SLF001
    s.configure(partials=default)
    assert s._partials_enabled is default  # noqa: SLF001
