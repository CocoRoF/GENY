"""Pin tests for the display-layer text sanitizer.

Cycle 20260421_2 / plan 01: the sanitizer is the single source of
truth for how routing / emotion / think markers are stripped before
agent output reaches any user-visible surface. These tests lock
down the contract so later changes to the surface sinks
(chat_controller, agent_executor, thinking_trigger) can't
accidentally widen or narrow it.
"""

from __future__ import annotations

import pytest

from service.utils.text_sanitizer import sanitize_for_display


# ─────────────────────────────────────────────────────────────────
# Pure function — every category covered
# ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        # ── Empty / falsy ──
        ("", ""),
        (None, ""),
        ("   ", ""),
        # ── Plain text unchanged ──
        ("안녕하세요", "안녕하세요"),
        ("Hello, world!", "Hello, world!"),
        # ── Single emotion tag ──
        ("[joy] 안녕!", "안녕!"),
        ("안녕! [joy]", "안녕!"),
        # ── Multiple emotion tags mixed in ──
        ("[joy] 안녕 [smirk] 반가워", "안녕 반가워"),
        # Every canonical emotion should be recognised
        ("[neutral] x [anger] y [disgust] z", "x y z"),
        ("[fear] x [sadness] y [surprise] z", "x y z"),
        ("[warmth] x [curious] y [calm] z", "x y z"),
        ("[excited] x [shy] y [proud] z", "x y z"),
        ("[grateful] x [playful] y [confident] z", "x y z"),
        ("[thoughtful] x [concerned] y [amused] z [tender] w", "x y z w"),
        # ── Routing / system prefixes ──
        ("[SUB_WORKER_RESULT] 워커 답장", "워커 답장"),
        ("[THINKING_TRIGGER] 조용하네", "조용하네"),
        ("[THINKING_TRIGGER:first_idle] 조용하네", "조용하네"),
        ("[CLI_RESULT] legacy", "legacy"),
        ("[ACTIVITY_TRIGGER] hi", "hi"),
        ("[ACTIVITY_TRIGGER:user_return] hi", "hi"),
        ("[DELEGATION_REQUEST] do this", "do this"),
        ("[DELEGATION_RESULT] done", "done"),
        ("[autonomous_signal:morning_check] ping", "ping"),
        ("[SILENT] quiet", "quiet"),
        # ── Case insensitivity ──
        ("[JOY] hi", "hi"),
        ("[Sub_Worker_Result] x", "x"),
        ("[thinking_trigger:X] y", "y"),
        # ── Combined routing + emotion (the user-reported case) ──
        (
            "[SUB_WORKER_RESULT] 워케에게서 답장이 왔어요! [joy]\n\n"
            "워커가 정말 친근하게 인사해주네요~ [surprise]",
            "워케에게서 답장이 왔어요! 워커가 정말 친근하게 인사해주네요~",
        ),
        # ── <think> blocks ──
        ("<think>internal</think>Hello", "Hello"),
        ("Hi <think>a</think>there<think>b</think>", "Hi there"),
        ("Pre <think>reasoning\nacross\nlines</think> post", "Pre post"),
        # ── Unclosed <think> block — everything after is dropped ──
        ("<think>never closed", ""),
        ("visible <think>rest is dropped", "visible"),
        # ── Unknown bracketed tokens are preserved ──
        ("[random_thing] stays", "[random_thing] stays"),
        ("[note: todo] also stays", "[note: todo] also stays"),
        # Input-only routing tags (not in output vocabulary) preserved —
        # the classifier handles them at input; output sanitizer stays
        # conservative.
        (
            "[INBOX from Alice] should stay",
            "[INBOX from Alice] should stay",
        ),
        (
            "[DM to Bob (internal)] not stripped",
            "[DM to Bob (internal)] not stripped",
        ),
        # ── Whitespace collapsing ──
        ("a   b   c", "a b c"),
        ("[joy]    안녕", "안녕"),
        ("before [joy]   after", "before after"),
        # ── Emotion tags with no following space ──
        ("[joy]hello", "hello"),
        # ── Tags at boundaries ──
        ("\n\n[joy]\n\nhello\n\n", "hello"),
    ],
)
def test_sanitize_for_display(text: str | None, expected: str) -> None:
    assert sanitize_for_display(text) == expected


# ─────────────────────────────────────────────────────────────────
# Partial / streaming input — token-boundary safety
# ─────────────────────────────────────────────────────────────────


def test_partial_tag_at_end_is_preserved() -> None:
    """Streaming accumulator: if the current buffer ends mid-tag, the
    partial tag must survive so the next appended chunk can complete
    it. The sanitizer only strips complete, recognised tags.
    """
    assert sanitize_for_display("hello [j") == "hello [j"
    assert sanitize_for_display("hello [jo") == "hello [jo"
    # Only once complete AND recognised does stripping happen.
    assert sanitize_for_display("hello [joy") == "hello [joy"
    assert sanitize_for_display("hello [joy]") == "hello"


def test_partial_think_open_drops_everything_after() -> None:
    """Conservative choice: if we see <think> but no </think>, treat
    the remainder as in-progress reasoning that must not be shown.
    A later chunk closing the block also produces empty (or the
    pre-think portion), which is fine — reasoning stays hidden.
    """
    assert sanitize_for_display("visible <think>partial") == "visible"


# ─────────────────────────────────────────────────────────────────
# Back-compat shim — tts_controller.sanitize_tts_text
# ─────────────────────────────────────────────────────────────────


def test_tts_shim_matches_sanitize_for_display() -> None:
    from controller.tts_controller import sanitize_tts_text
    sample = "[SUB_WORKER_RESULT] hi [joy] there"
    assert sanitize_tts_text(sample) == sanitize_for_display(sample)
    assert sanitize_tts_text(sample) == "hi there"
