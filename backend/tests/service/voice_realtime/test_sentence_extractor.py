"""Incremental sentence extraction (realtime voice TTS feeder)."""

from __future__ import annotations

from service.voice_realtime.sentence import IncrementalSentenceExtractor


def _drain(ex: IncrementalSentenceExtractor, chunks):
    """Feed cumulative snapshots, collect all emitted sentences + flush."""
    out = []
    acc = ""
    for c in chunks:
        acc += c
        out.extend(ex.push(acc))
    out.extend(ex.flush())
    return out


def test_korean_sentences_split_on_terminators():
    ex = IncrementalSentenceExtractor(min_chars=1)
    out = _drain(ex, ["안녕하세요. ", "오늘 날씨가 좋네요! ", "산책 갈까요?"])
    assert out == ["안녕하세요.", "오늘 날씨가 좋네요!", "산책 갈까요?"]


def test_never_reemits_completed_span():
    ex = IncrementalSentenceExtractor(min_chars=1)
    first = ex.push("첫 문장입니다. 둘째")
    assert first == ["첫 문장입니다."]
    # Cumulative grows; the already-emitted first sentence must not repeat.
    second = ex.push("첫 문장입니다. 둘째 문장이에요.")
    assert second == ["둘째 문장이에요."]
    assert ex.flush() == []


def test_short_fragment_held_then_merged():
    ex = IncrementalSentenceExtractor(min_chars=12)
    # "네." is below min_chars → held and merged forward with the next.
    mid = ex.push("네. ")
    assert mid == []
    done = ex.push("네. 그거 정말 좋은 생각이에요.")
    assert done == ["네. 그거 정말 좋은 생각이에요."]


def test_flush_emits_unterminated_tail():
    ex = IncrementalSentenceExtractor(min_chars=1)
    assert ex.push("종결부호 없는 마지막 조각") == []
    assert ex.flush() == ["종결부호 없는 마지막 조각"]


def test_runon_line_forced_at_length_ceiling():
    ex = IncrementalSentenceExtractor(min_chars=1, max_chars=20)
    long = "word " * 20  # 100 chars, no terminator
    got = ex.push(long)
    assert got, "a run-on line past the ceiling must still emit"
    assert all(len(s) <= 25 for s in got)


def test_newline_is_a_boundary():
    ex = IncrementalSentenceExtractor(min_chars=1)
    out = _drain(ex, ["첫 줄\n", "둘째 줄\n"])
    assert out == ["첫 줄", "둘째 줄"]


def test_latin_sentences():
    ex = IncrementalSentenceExtractor(min_chars=1)
    out = _drain(ex, ["Hello there. ", "How are you? ", "Great!"])
    assert out == ["Hello there.", "How are you?", "Great!"]


def test_ellipsis_and_quotes():
    ex = IncrementalSentenceExtractor(min_chars=1)
    out = _drain(ex, ['그는 "안녕"이라고 말했다. ', "그리고 떠났다…"])
    assert out == ['그는 "안녕"이라고 말했다.', "그리고 떠났다…"]
