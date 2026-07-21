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
            # Blank line is PRESERVED — display renders markdown, so the
            # paragraph break must survive (only horizontal ws collapses).
            "워케에게서 답장이 왔어요!\n\n워커가 정말 친근하게 인사해주네요~",
        ),
        # ── <think> blocks ──
        ("<think>internal</think>Hello", "Hello"),
        ("Hi <think>a</think>there<think>b</think>", "Hi there"),
        ("Pre <think>reasoning\nacross\nlines</think> post", "Pre post"),
        # ── Unclosed <think> block — everything after is dropped ──
        ("<think>never closed", ""),
        ("visible <think>rest is dropped", "visible"),
        # ── X7: unknown lowercase single-word brackets are now STRIPPED ──
        # This is the catch-all safety net for emotion-like tags the
        # LLM invents outside the taxonomy. See taxonomy.py docstring.
        ("[random_thing] stays", "stays"),
        # Tags with colons + spaces / punctuation are NOT single-word
        # identifiers, so they remain — the narrow catch-all preserves
        # these legitimate bracketed payloads.
        ("[note: todo] also stays", "[note: todo] also stays"),
        # Input-only routing tags with spaces / capitals / punctuation
        # stay preserved — the catch-all is intentionally narrow.
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


def test_display_preserves_block_structure() -> None:
    """Blank lines between markdown blocks must survive so the chat UI
    renders headings / tables / block quotes instead of one glued line.
    Regression: a ``\\s{2,}`` collapse used to fuse these onto one line,
    which broke GFM table detection (the header row glued to prose has the
    wrong column count) and left ``##`` headings mid-paragraph.
    """
    src = (
        "정리했어.\n\n"
        "## 1. Jira 등록 항목\n\n"
        "설명 줄.\n\n"
        "| Key | 제목 |\n"
        "|-----|------|\n"
        "| WG2026-530 | 문서 |\n"
    )
    out = sanitize_for_display(src)
    # Block separators intact → the table header sits on its own line.
    assert "## 1. Jira 등록 항목" in out
    assert "\n| Key | 제목 |\n|-----|------|" in out
    # No block got glued onto the preceding line.
    assert "정리했어. ##" not in out
    assert "설명 줄. | Key |" not in out


def test_display_collapses_horizontal_ws_and_caps_blank_lines() -> None:
    # Horizontal runs still collapse; blank-line runs cap at one.
    assert sanitize_for_display("a   b\t\tc") == "a b c"
    assert sanitize_for_display("a\n\n\n\n\nb") == "a\n\nb"
    # Spaces hugging a newline are trimmed but the newline stays.
    assert sanitize_for_display("a   \n   b") == "a\nb"


def test_display_keeps_fenced_code_indentation() -> None:
    # Code inside a fence must not be flattened (indentation preserved).
    src = "```python\ndef f():\n    return 1\n```"
    assert sanitize_for_display(src) == src


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


def test_tts_shim_strips_routing_and_emotion_tags() -> None:
    # The shim now delegates to ``sanitize_for_tts`` which is
    # ``sanitize_for_display`` + emoji/emoticon strip. For inputs
    # without emoji the two functions still agree.
    from controller.tts_controller import sanitize_tts_text
    sample = "[SUB_WORKER_RESULT] hi [joy] there"
    assert sanitize_tts_text(sample) == "hi there"
    assert sanitize_tts_text(sample) == sanitize_for_display(sample)


# ─────────────────────────────────────────────────────────────────
# Memory v2 followup — TTS emoji / emoticon strip
# ─────────────────────────────────────────────────────────────────


def test_sanitize_for_tts_strips_basic_emoji() -> None:
    from service.utils.text_sanitizer import sanitize_for_tts
    assert "😊" not in sanitize_for_tts("hi 😊")
    assert "✨" not in sanitize_for_tts("✨ wow ✨")
    assert "⭐" not in sanitize_for_tts("⭐ star ⭐")
    # Bare emoticons
    assert ":)" not in sanitize_for_tts("ok :)")
    assert "ㅋㅋ" not in sanitize_for_tts("hi ㅋㅋ there")


def test_sanitize_for_tts_preserves_plain_text() -> None:
    """Korean text, ASCII letters, and plain directional arrows
    must survive — only emoji-presentation glyphs are removed.
    """
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("안녕하세요") == "안녕하세요"
    assert sanitize_for_tts("hello world") == "hello world"
    # Plain arrows (U+2190 / U+2192) — used in legitimate Korean
    # text, must NOT be stripped (they pronounce sensibly).
    assert "→" in sanitize_for_tts("a → b")
    assert "←" in sanitize_for_tts("a ← b")


def test_sanitize_for_tts_user_reported_case() -> None:
    """The exact wording the user complained about — VTuber emitted
    a 😊 mid-sentence and TTS spoke it as English ``smiling-face``.
    """
    from service.utils.text_sanitizer import sanitize_for_tts
    inp = (
        "안녕하세요! 처음 뵙네요. 저는 아직 이름이 정해지지 않았는데... "
        "뭐라고 불러드릴까요? 😊"
    )
    out = sanitize_for_tts(inp)
    assert "😊" not in out
    assert "안녕하세요" in out
    assert "불러드릴까요" in out


def test_sanitize_for_tts_strips_zwj_sequences() -> None:
    """Multi-codepoint emoji joined by ZWJ (family / profession
    sequences) must be stripped wholesale, not leave dangling
    base characters.
    """
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("hi 👨‍👩‍👧 family") == "hi family"
    assert sanitize_for_tts("👍🏼 thumbs") == "thumbs"


def test_sanitize_for_display_keeps_emoji() -> None:
    """Display surfaces (chat UI) DO render emoji. Only TTS strips."""
    assert "😊" in sanitize_for_display("hi 😊")
    assert "⭐" in sanitize_for_display("⭐ star")


# ─────────────────────────────────────────────────────────────────
# Markdown stripping for TTS — agents reply with headings,
# emphasis, wikilinks, etc.; TTS must voice prose, not punctuation.
# ─────────────────────────────────────────────────────────────────


def test_sanitize_for_tts_strips_headings_and_emphasis() -> None:
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("**bold**") == "bold"
    assert sanitize_for_tts("*italic*") == "italic"
    assert sanitize_for_tts("***both***") == "both"
    assert sanitize_for_tts("# Heading\nbody") == "Heading body"
    assert sanitize_for_tts("## subheading\ntext") == "subheading text"
    # Emphasis on Korean text
    assert sanitize_for_tts("**굵은 글씨**") == "굵은 글씨"
    assert sanitize_for_tts("*기울임*") == "기울임"


def test_sanitize_for_tts_strips_lists_and_blockquotes() -> None:
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("- item one\n- item two") == "item one item two"
    assert sanitize_for_tts("* a\n* b\n* c") == "a b c"
    assert sanitize_for_tts("1. first\n2. second") == "first second"
    assert sanitize_for_tts("> quoted text") == "quoted text"


def test_sanitize_for_tts_strips_horizontal_rules() -> None:
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("text\n---\nmore") == "text more"
    assert sanitize_for_tts("text\n***\nmore") == "text more"
    assert sanitize_for_tts("text\n___\nmore") == "text more"


def test_sanitize_for_tts_strips_inline_separators() -> None:
    """Topic dividers the persona drops *inline* (not on their own line) —
    ``a --- b``, em/en dashes, ``~~~`` — must not be voiced, while
    word-internal hyphens / identifiers survive.
    """
    from service.utils.text_sanitizer import sanitize_for_tts
    # The exact shape from the user's screenshot (inline --- between topics).
    assert sanitize_for_tts("직전입니다 😅 --- 🤖 AI 모델 쪽은") == "직전입니다 AI 모델 쪽은"
    assert sanitize_for_tts("a --- b") == "a b"
    assert sanitize_for_tts("a — b") == "a b"        # em-dash
    assert sanitize_for_tts("a – b") == "a b"        # en-dash
    assert sanitize_for_tts("a - b") == "a b"        # lone hyphen separator
    assert sanitize_for_tts("foo ~~~ bar") == "foo bar"
    assert sanitize_for_tts("one --- two --- three") == "one two three"
    assert sanitize_for_tts("--- 시작") == "시작"     # leading divider
    # Word-internal hyphens / identifiers / arrows must be preserved.
    assert sanitize_for_tts("e-mail 보내요") == "e-mail 보내요"
    assert sanitize_for_tts("GPT-4 와 Llama-5") == "GPT-4 와 Llama-5"
    assert sanitize_for_tts("test_file.py") == "test_file.py"
    assert "→" in sanitize_for_tts("분기 → 주")


def test_sanitize_for_tts_unwraps_links_and_wikilinks() -> None:
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("[link text](https://example.com)") == "link text"
    # Image syntax is dropped wholesale (alt rarely worth speaking).
    assert sanitize_for_tts("![alt](image.png) hello") == "hello"
    # Wikilinks — keep target or alias.
    assert sanitize_for_tts("[[wikilink]]") == "wikilink"
    assert sanitize_for_tts("[[target|alias label]]") == "alias label"
    # Conversation note pointer (the agent's typical wikilink shape).
    assert sanitize_for_tts(
        "본문은 [[conversations/2026-05-01/01-22-12__user__abcd1234|→ 본문]]"
    ) == "본문은 → 본문"


def test_sanitize_for_tts_unwraps_inline_and_fenced_code() -> None:
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("`code`") == "code"
    out = sanitize_for_tts("text before\n```python\nprint('hi')\n```\nafter")
    assert "print" in out and "```" not in out


def test_sanitize_for_tts_strips_html_tags() -> None:
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("<br>hello<b>world</b>") == "helloworld"


def test_sanitize_for_tts_preserves_underscore_in_words() -> None:
    """``test_file`` and ``python_3`` are common identifiers — the
    underscore-emphasis matcher must not strip the underscores when
    they're inside a word.
    """
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("test_file.py") == "test_file.py"
    assert sanitize_for_tts("python_3 is fast") == "python_3 is fast"


def test_sanitize_for_tts_user_reported_markdown_case() -> None:
    """The exact wording the user reported — agent replied with a
    full markdown-formatted block (headings, emphasis, lists,
    horizontal rule, blockquote, emoji) and TTS read the
    punctuation literally.
    """
    from service.utils.text_sanitizer import sanitize_for_tts
    inp = (
        "파일 내용 가져왔어요! 워커가 이렇게 써뒀네요 😊\n\n"
        "---\n\n"
        "# 안녕하세요! 저는 엘렌의 워커입니다 👋\n\n"
        "## 자기소개\n\n"
        "저는 Geny 플랫폼에서 엘렌과 함께 일하는 Sub-Worker 에이전트예요.\n\n"
        "## 제가 잘하는 것들 🛠️\n"
        "- **파일 작업**: 파일 생성, 수정, 읽기\n"
        "- *코드 실행*: 쉘 명령어 처리\n\n"
        "> 인용문 하나\n"
    )
    out = sanitize_for_tts(inp)
    # No markdown markers survive
    assert "#" not in out
    assert "**" not in out
    assert "---" not in out
    assert ">" not in out
    # Visible prose still there
    assert "안녕하세요" in out
    assert "엘렌의 워커입니다" in out
    assert "자기소개" in out
    assert "파일 작업" in out
    assert "코드 실행" in out
    assert "인용문 하나" in out
    # Emoji still gone (existing invariant)
    assert "😊" not in out
    assert "👋" not in out


def test_sanitize_for_tts_routing_still_stripped_after_markdown_unwrap() -> None:
    """The routing-tag pass runs *after* markdown unwrap so that
    constructs like ``[link](url)`` aren't gobbled by the unknown-
    bracket catch-all. The routing tag itself must still be removed.
    """
    from service.utils.text_sanitizer import sanitize_for_tts
    assert sanitize_for_tts("[SUB_WORKER_RESULT] result body") == "result body"
    assert sanitize_for_tts("[joy] hello") == "hello"


# ─────────────────────────────────────────────────────────────────
# X7 (cycle 20260422_5): expanded taxonomy + unknown-tag catch-all
# ─────────────────────────────────────────────────────────────────


def test_new_taxonomy_tags_are_stripped() -> None:
    """Tags that were added in X7 (wonder, amazement, satisfaction,
    curiosity) must now be recognized by the sanitizer whitelist."""
    for tag in ("wonder", "amazement", "satisfaction", "curiosity"):
        assert sanitize_for_display(f"[{tag}] hi") == "hi", (
            f"tag {tag!r} should be stripped after X7"
        )


def test_unknown_lowercase_tag_stripped_by_catch_all() -> None:
    """User-reported leak: `[bewildered]` / `[melancholy]` were not in
    the old whitelist; the X7 catch-all strips any unseen lowercase
    bracket identifier (3-20 chars)."""
    assert sanitize_for_display("[bewildered] thinking") == "thinking"
    assert sanitize_for_display("mid [melancholy] sentence") == "mid sentence"


def test_catch_all_preserves_routing_tags() -> None:
    """The narrow catch-all must not eat uppercase routing tags — those
    are handled by SYSTEM_TAG_PATTERN separately with precise matches."""
    # SUB_WORKER_RESULT is uppercase_underscore → routing path strips it;
    # the catch-all would ignore it regardless. The assertion here is
    # about ordering + pattern narrowness.
    assert sanitize_for_display("[SUB_WORKER_RESULT] done") == "done"
    assert sanitize_for_display("[THINKING_TRIGGER] ok") == "ok"


def test_catch_all_preserves_short_or_numeric_brackets() -> None:
    """`[a]`, `[1]`, `[to]`, `[x1]` stay — legitimate user text
    (footnote refs, numbers, list markers)."""
    assert sanitize_for_display("footnote [a] and [1]") == "footnote [a] and [1]"
    assert sanitize_for_display("word [to] word") == "word [to] word"
    # Even 2-char lowercase stays (below min length 3)
    assert sanitize_for_display("tag [hi]") == "tag [hi]"


# ─────────────────────────────────────────────────────────────────
# X7-follow-up (cycle 20260422_5): ``:strength`` suffix coverage
# ─────────────────────────────────────────────────────────────────
# User reported raw ``[excitement:0.7]`` leaking to the VTuber chat —
# the display sanitizer regexes were missing optional-strength support.
# Pin both the whitelisted path AND the catch-all here.


def test_recognized_tag_with_strength_is_stripped() -> None:
    """Tags decorated with ``:N`` or ``:N.N`` strength still strip."""
    assert sanitize_for_display("[excitement:0.7] 좋아") == "좋아"
    assert sanitize_for_display("[joy:1.5] hi") == "hi"
    assert sanitize_for_display("mid [fear:2] end") == "mid end"
    # Negative strength + no fraction
    assert sanitize_for_display("[calm:-1] sedated") == "sedated"


def test_recognized_tag_with_whitespace_inside_bracket() -> None:
    """Slightly sloppy LLM output — spaces inside the bracket — strips."""
    assert sanitize_for_display("[ joy ] yo") == "yo"
    assert sanitize_for_display("[joy : 0.5] yo") == "yo"
    assert sanitize_for_display("[ excitement:0.7 ] 좋아") == "좋아"


def test_unknown_tag_with_strength_is_stripped() -> None:
    """Catch-all must also tolerate ``:strength`` on unknown tags."""
    assert sanitize_for_display("[bewildered:0.3] thinking") == "thinking"
    assert sanitize_for_display("[melancholy:1.5] mood") == "mood"


def test_strength_does_not_unlock_routing_tags() -> None:
    """Uppercase routing tags must stay bypassed even with a colon
    payload — the catch-all is narrow on the identifier side."""
    # Routing tags already strip via SYSTEM_TAG_PATTERN; strength should
    # still land on the existing cases (THINKING_TRIGGER:first_idle).
    assert sanitize_for_display("[THINKING_TRIGGER:x] ok") == "ok"


def test_recognized_tags_imported_from_taxonomy() -> None:
    """Canonical list must be the taxonomy, not an in-file duplicate."""
    from service.affect.taxonomy import RECOGNIZED_TAGS as canonical
    from service.utils.text_sanitizer import EMOTION_TAGS
    assert EMOTION_TAGS is canonical
