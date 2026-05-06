"""Blog Agent 위임 telemetry / audit 링.

In-process 고정 크기 deque — DB 쓰기 없음. 운영자가 어떤 Geny 세션이
언제 무엇을 위임했는지 한 눈에 보기 위한 디버그 surface.

기록 대상:

  blog_agent.delegate.start    위임 시작
  blog_agent.delegate.complete 위임 완료 (status=done|cancelled|error)
  blog_agent.cancel            사용자 / 시스템 취소
  blog_agent.transport_error   네트워크 / HTTP 실패

API 키는 절대 기록하지 않는다. base_url 만 노출 (운영자가 어떤 인스턴스
호출인지 파악 가능). audit 표기의 task_summary 는 사용자가 들려준 한 줄
이라 민감하지 않으나, 그래도 200 자 cap.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Deque, Dict, List, Optional

_CAP = 500
_buffer: Deque[Dict[str, Any]] = deque(maxlen=_CAP)
_lock = Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _trim(s: Optional[str], n: int = 200) -> str:
    if not s:
        return ""
    return s if len(s) <= n else s[:n] + "…"


def record_delegate_start(
    *,
    geny_session_id: str,
    blog_session_uid: str,
    task_id: str,
    summary_chars: int = 0,
) -> None:
    with _lock:
        _buffer.append({
            "ts": _now(),
            "event": "blog_agent.delegate.start",
            "geny_session_id": geny_session_id,
            "blog_session_uid": blog_session_uid,
            "task_id": task_id,
            "summary_chars": summary_chars,
        })


def record_delegate_complete(
    *,
    geny_session_id: str,
    blog_session_uid: str,
    task_id: str,
    status: str,
    duration_s: float,
    frame_count: int,
    final_text_len: int,
    error: Optional[str] = None,
) -> None:
    with _lock:
        _buffer.append({
            "ts": _now(),
            "event": "blog_agent.delegate.complete",
            "geny_session_id": geny_session_id,
            "blog_session_uid": blog_session_uid,
            "task_id": task_id,
            "status": status,
            "duration_s": round(duration_s, 2),
            "frame_count": frame_count,
            "final_text_len": final_text_len,
            "error": _trim(error, 300) if error else None,
        })


def record_cancel(
    *,
    geny_session_id: str,
    task_id: str,
    reason: str = "user",
) -> None:
    with _lock:
        _buffer.append({
            "ts": _now(),
            "event": "blog_agent.cancel",
            "geny_session_id": geny_session_id,
            "task_id": task_id,
            "reason": reason,
        })


def record_transport_error(
    *,
    geny_session_id: Optional[str],
    base_url: str,
    status_code: Optional[int],
    detail: str,
) -> None:
    with _lock:
        _buffer.append({
            "ts": _now(),
            "event": "blog_agent.transport_error",
            "geny_session_id": geny_session_id,
            "base_url": base_url,
            "status_code": status_code,
            "detail": _trim(detail, 300),
        })


def history(limit: int = 100) -> List[Dict[str, Any]]:
    with _lock:
        items = list(_buffer)
    if limit < len(items):
        return items[-limit:]
    return items


def clear() -> None:
    with _lock:
        _buffer.clear()


__all__ = [
    "clear",
    "history",
    "record_cancel",
    "record_delegate_complete",
    "record_delegate_start",
    "record_transport_error",
]
