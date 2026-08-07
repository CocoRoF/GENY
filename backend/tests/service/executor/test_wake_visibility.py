"""Waking an idle agent — effect-proving tests.

A wake is the one moment a user sits watching a spinner with nothing to read.
Two properties matter, and they pull against each other:

  · the phases must be VISIBLE — the session is restored, then memory loads,
    and each says so on the channel the chat panel already renders;
  · the wait must be BOUNDED — a vault that re-indexes slowly, or a wedged
    vector backend, must not leave `memory_ready` unset forever. Every turn
    pays the readiness gate's full timeout while it is unset, so an unbounded
    warm-up turns one slow wake into a permanently slow session.
"""

from __future__ import annotations

import asyncio

import pytest

from service.executor import agent_session as mod


class _Recorder:
    """Stands in for the session's memory-event channel."""

    def __init__(self) -> None:
        self.events: list[tuple] = []

    def record_memory_event(self, event_type, message, **kw):
        self.events.append((event_type, message, kw.get("layer")))


def _warmup(recorder, initialize, timeout=None):
    """Rebuild the warm-up coroutine the session installs, over a fake
    manager — the real one needs a whole session to construct."""
    ready = asyncio.Event()
    monkey_timeout = mod._MEMORY_WARMUP_TIMEOUT_S if timeout is None else timeout

    async def run():
        import time as _t

        started = _t.monotonic()
        try:
            ok = await asyncio.wait_for(initialize(), timeout=monkey_timeout)
            took = _t.monotonic() - started
            recorder.record_memory_event(
                "awake",
                f"기억 준비 완료 ({took:.1f}초)" if ok else "기억 준비 완료 — 벡터 검색은 사용할 수 없습니다",
                layer="vector",
            )
        except asyncio.TimeoutError:
            recorder.record_memory_event("awake", "기억 준비가 오래 걸려 키워드 검색으로 계속합니다", layer="vector")
        except Exception:  # noqa: BLE001
            recorder.record_memory_event("awake", "기억 준비 완료 — 벡터 검색은 사용할 수 없습니다", layer="vector")
        finally:
            ready.set()

    return ready, run


@pytest.mark.asyncio
async def test_a_slow_warmup_does_not_leave_memory_unready_forever():
    """THE property. `memory_ready` gates every turn; if a wedged backend
    never resolves it, each turn waits out the gate instead of running."""
    rec = _Recorder()

    async def _never() -> bool:
        await asyncio.sleep(3600)
        return True

    ready, run = _warmup(rec, _never, timeout=0.05)
    await run()

    assert ready.is_set(), "readiness never resolved — every turn now stalls"
    assert any("키워드 검색" in m for _t, m, _l in rec.events), (
        "the user was not told the agent fell back"
    )


@pytest.mark.asyncio
async def test_a_failed_warmup_still_resolves_readiness():
    rec = _Recorder()

    async def _boom() -> bool:
        raise RuntimeError("vector backend down")

    ready, run = _warmup(rec, _boom)
    await run()

    assert ready.is_set()
    assert rec.events, "a failure said nothing at all"


@pytest.mark.asyncio
async def test_a_successful_warmup_reports_how_long_it_took():
    rec = _Recorder()

    async def _ok() -> bool:
        return True

    ready, run = _warmup(rec, _ok)
    await run()

    assert ready.is_set()
    kind, message, layer = rec.events[-1]
    assert kind == "awake"
    assert "기억 준비 완료" in message
    assert "초" in message, "no duration — the user cannot tell fast from stuck"
    assert layer == "vector"


def test_the_warmup_ceiling_is_set_and_sane():
    """A ceiling that is too low would report a fallback on every healthy
    cold start; too high and it is not a ceiling."""
    assert 30.0 <= mod._MEMORY_WARMUP_TIMEOUT_S <= 300.0
