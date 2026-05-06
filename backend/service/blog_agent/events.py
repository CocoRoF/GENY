"""SSE frame 파서.

블로그의 ``POST /sessions/{uid}/messages/stream`` 가 흘리는 frame 형식:

    event: <type>\n
    data: <json>\n
    \n

한 frame 은 빈 라인으로 구분되는 블록 단위. ``parse_sse_block`` 가
한 블록(여러 라인) 을 받아 ``Frame`` 으로 정규화. 잘린 chunk 는
호출자(Client.stream_message) 가 line buffering 으로 합쳐서 넘긴다.

알려진 frame type (BLOG_AGENT_DELEGATION_PLAN.md § 5):

    assistant_text   text: str
    tool_call        tool_name, tool_input, tool_use_id
    tool_result      tool_use_id, result, is_error
    approval_needed  tool_use_id, tool_name, ...
    thinking         text
    turn_complete    usage, cumulative
    error            message
    info             자유

미지의 type 은 ``Frame(type="<received>", data={...}, raw_unknown=True)`` 로
보존 → pump 가 warn 로그 + 무해 처리.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


_KNOWN_TYPES = frozenset({
    "assistant_text",
    "tool_call",
    "tool_result",
    "approval_needed",
    "thinking",
    "turn_complete",
    "error",
    "info",
})


@dataclass
class Frame:
    """정규화된 SSE frame."""

    type: str
    data: Dict[str, Any] = field(default_factory=dict)
    raw_unknown: bool = False

    @property
    def is_terminal(self) -> bool:
        """이 frame 도착 후 stream 이 사실상 끝났는지."""
        return self.type in ("turn_complete", "error")


def parse_sse_block(block: str) -> Optional[Frame]:
    """한 SSE 블록(빈 줄로 구분된 여러 라인) 을 ``Frame`` 으로 변환.

    형식이 깨진 블록은 None 을 반환 — 호출자가 무시하면 된다.
    data 가 JSON 이 아니면 ``data={"raw": <str>}`` 로 보존.
    """
    if not block or not block.strip():
        return None

    event_type: Optional[str] = None
    data_lines: list[str] = []

    for raw_line in block.splitlines():
        line = raw_line.rstrip("\r")
        if not line:
            continue
        if line.startswith(":"):
            # SSE comment — keepalive ping 등. 무시.
            continue
        if line.startswith("event:"):
            event_type = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())
        else:
            # SSE 스펙상 id:/retry: 도 있지만 우리 프로토콜은 안 씀.
            continue

    if event_type is None and not data_lines:
        return None

    raw_data = "\n".join(data_lines)
    parsed: Dict[str, Any]
    if not raw_data:
        parsed = {}
    else:
        try:
            parsed = json.loads(raw_data)
            if not isinstance(parsed, dict):
                parsed = {"value": parsed}
        except json.JSONDecodeError:
            parsed = {"raw": raw_data}

    resolved_type = event_type or parsed.get("type") or "info"
    is_unknown = resolved_type not in _KNOWN_TYPES
    return Frame(type=resolved_type, data=parsed, raw_unknown=is_unknown)


def iter_blocks_from_lines(lines_buffer: list[str], complete_block: bool = False) -> list[str]:
    """``lines_buffer`` 에 누적된 라인들을 빈 줄 기준으로 블록 list 로 분할.

    Args:
        lines_buffer: 누적된 라인. 호출 후에도 그대로 둬야 다음 호출이 이어
            처리할 수 있다 (이 함수는 buffer 를 mutate 하지 않음).
        complete_block: True 이면 마지막 블록 (빈 줄로 안 끝났더라도)
            도 포함해서 반환. EOF 처리 용도.

    Returns:
        블록 문자열 리스트 (각 블록은 newline join 된 형태). 빈 블록은 제외.
    """
    blocks: list[str] = []
    current: list[str] = []
    for line in lines_buffer:
        if line == "" or line == "\n" or line == "\r\n":
            if current:
                blocks.append("\n".join(current))
                current = []
            continue
        current.append(line)
    if complete_block and current:
        blocks.append("\n".join(current))
    return blocks
