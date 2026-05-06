"""SSE frame parser 단위 테스트."""
from __future__ import annotations

import json

from service.blog_agent.events import Frame, parse_sse_block, iter_blocks_from_lines


def test_parse_assistant_text_block() -> None:
    block = "event: assistant_text\ndata: {\"text\": \"hello\"}"
    frame = parse_sse_block(block)
    assert frame is not None
    assert frame.type == "assistant_text"
    assert frame.data == {"text": "hello"}
    assert frame.raw_unknown is False
    assert frame.is_terminal is False


def test_parse_turn_complete_is_terminal() -> None:
    block = (
        "event: turn_complete\n"
        'data: {"usage": {"input_tokens": 10, "output_tokens": 20}}'
    )
    frame = parse_sse_block(block)
    assert frame is not None
    assert frame.type == "turn_complete"
    assert frame.is_terminal is True
    assert frame.data["usage"]["input_tokens"] == 10


def test_parse_error_is_terminal() -> None:
    block = "event: error\ndata: {\"message\": \"boom\"}"
    frame = parse_sse_block(block)
    assert frame is not None
    assert frame.type == "error"
    assert frame.is_terminal is True


def test_parse_unknown_event_marked_unknown() -> None:
    block = "event: brand_new_type\ndata: {\"x\": 1}"
    frame = parse_sse_block(block)
    assert frame is not None
    assert frame.type == "brand_new_type"
    assert frame.raw_unknown is True


def test_parse_block_without_event_uses_data_type() -> None:
    block = 'data: {"type": "assistant_text", "text": "yo"}'
    frame = parse_sse_block(block)
    assert frame is not None
    assert frame.type == "assistant_text"
    assert frame.data["text"] == "yo"


def test_parse_invalid_json_preserves_raw() -> None:
    block = "event: info\ndata: not-json-{"
    frame = parse_sse_block(block)
    assert frame is not None
    assert frame.type == "info"
    assert frame.data == {"raw": "not-json-{"}


def test_parse_empty_block_returns_none() -> None:
    assert parse_sse_block("") is None
    assert parse_sse_block("\n\n") is None


def test_parse_comment_lines_ignored() -> None:
    block = ":keepalive\nevent: assistant_text\ndata: {\"text\": \"hi\"}"
    frame = parse_sse_block(block)
    assert frame is not None
    assert frame.type == "assistant_text"


def test_iter_blocks_splits_on_blank_lines() -> None:
    lines = [
        "event: assistant_text",
        'data: {"text": "a"}',
        "",
        "event: assistant_text",
        'data: {"text": "b"}',
        "",
    ]
    blocks = iter_blocks_from_lines(lines)
    assert len(blocks) == 2
    f1 = parse_sse_block(blocks[0])
    f2 = parse_sse_block(blocks[1])
    assert f1.data["text"] == "a"
    assert f2.data["text"] == "b"


def test_iter_blocks_keeps_trailing_when_complete_block_true() -> None:
    lines = ["event: error", 'data: {"message": "x"}']
    blocks_no_eof = iter_blocks_from_lines(lines)
    blocks_eof = iter_blocks_from_lines(lines, complete_block=True)
    assert blocks_no_eof == []
    assert len(blocks_eof) == 1
