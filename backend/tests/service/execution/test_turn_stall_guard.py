"""Bounding a turn by PROGRESS, not just elapsed time.

A session's ceiling is 1800s. That is a backstop for a runaway turn, not a
safety net at a conversation's timescale: a wedged turn sat there for 29
minutes with the user watching a spinner before anything gave up. Every
failure this codebase has hit — a stuck subprocess, a wedged engine lock, a
child process nobody reaped — looks exactly like that from here.

A turn doing real work writes to the session log continuously, and
``get_cache_length()`` counts those writes. Silence is the signal that
separates "slow" from "stuck", and these tests pin it.
"""

from __future__ import annotations

import asyncio

import pytest

from service.execution import agent_executor as mod

#: Captured at import, before any fixture shortens it for the fast tests.
SHIPPED_STALL_S = mod._STALL_TIMEOUT_S


class _Entry:
    def __init__(self, level):
        self.level = level


class _Logger:
    """Session log stand-in.

    `bump()` is a TURN event; `background()` is the memory/trigger chatter
    that shares this log and must not read as the turn making progress.
    """

    def __init__(self, start: int = 0) -> None:
        self.entries = []
        self.n = start

    def bump(self) -> None:
        self.entries.append(_Entry(mod.LogLevel.STAGE))
        self.n += 1

    def background(self) -> None:
        self.entries.append(_Entry(mod.LogLevel.INFO))
        self.n += 1

    def get_cache_length(self) -> int:
        return self.n

    def get_cache_entries_since(self, cursor: int):
        new = self.entries[cursor:]
        return new, len(self.entries)


class _Agent:
    def __init__(self, coro_factory) -> None:
        self._factory = coro_factory
        self.cancelled = False

    async def invoke(self, input_text: str, **kwargs):
        try:
            return await self._factory()
        except asyncio.CancelledError:
            self.cancelled = True
            raise


async def _run(agent, logger, *, total=60.0):
    return await mod._invoke_bounded(
        agent, prompt="hi", invoke_kwargs={}, total_timeout=total,
        session_logger=logger, session_id="sid-123456",
    )


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(mod, "_STALL_POLL_S", 0.02)
    monkeypatch.setattr(mod, "_STALL_TIMEOUT_S", 0.15)


@pytest.mark.asyncio
async def test_a_normal_turn_returns_its_result():
    async def _quick():
        return {"output": "안녕"}

    assert await _run(_Agent(_quick), _Logger()) == {"output": "안녕"}


@pytest.mark.asyncio
async def test_a_turn_that_keeps_working_is_not_cut_off():
    """THE property that makes the guard safe to enable. A long turn that is
    genuinely progressing must survive well past the stall window."""
    logger = _Logger()

    async def _long():
        for _ in range(20):          # ~0.4s, far beyond the 0.15s stall window
            await asyncio.sleep(0.02)
            logger.bump()
        return {"output": "완료"}

    agent = _Agent(_long)
    assert await _run(agent, logger) == {"output": "완료"}
    assert agent.cancelled is False


@pytest.mark.asyncio
async def test_a_silent_turn_is_abandoned():
    """No log writes at all — a wedged subprocess or a blocked lock."""
    async def _wedged():
        await asyncio.sleep(30)

    agent = _Agent(_wedged)
    with pytest.raises(asyncio.TimeoutError):
        await _run(agent, _Logger())
    assert agent.cancelled is True, "the wedged turn was left running"


@pytest.mark.asyncio
async def test_a_turn_that_stalls_midway_is_abandoned():
    """Progress then silence — the shape of a turn that dies partway."""
    logger = _Logger()

    async def _stalls():
        for _ in range(3):
            await asyncio.sleep(0.02)
            logger.bump()
        await asyncio.sleep(30)      # …and then nothing, ever

    with pytest.raises(asyncio.TimeoutError):
        await _run(_Agent(_stalls), logger)


@pytest.mark.asyncio
async def test_the_ceiling_still_applies():
    """The stall guard replaces nothing — a turn that chats forever while
    logging busily must still hit the total budget."""
    logger = _Logger()

    async def _forever():
        while True:
            await asyncio.sleep(0.01)
            logger.bump()

    agent = _Agent(_forever)
    with pytest.raises(asyncio.TimeoutError):
        await _run(agent, logger, total=0.2)
    assert agent.cancelled is True


@pytest.mark.asyncio
async def test_without_a_progress_signal_only_the_ceiling_bounds_the_turn():
    """A session with no logger must not be declared stalled — inventing a
    stall there would kill healthy turns."""
    async def _slow():
        await asyncio.sleep(0.4)
        return {"output": "느리지만 정상"}

    assert await _run(_Agent(_slow), None, total=5.0) == {"output": "느리지만 정상"}


@pytest.mark.asyncio
async def test_a_broken_progress_probe_does_not_fail_the_turn():
    class _Broken:
        def get_cache_length(self):
            raise RuntimeError("logger gone")

    async def _slow():
        await asyncio.sleep(0.3)
        return {"output": "ok"}

    assert await _run(_Agent(_slow), _Broken(), total=5.0) == {"output": "ok"}


@pytest.mark.asyncio
async def test_a_turn_that_raises_propagates_its_own_error():
    """The guard must not mask a real failure as a timeout."""
    async def _boom():
        raise ValueError("모델 오류")

    with pytest.raises(ValueError, match="모델 오류"):
        await _run(_Agent(_boom), _Logger())


def test_the_stall_window_is_sane():
    """Too short cuts off legitimate long tool calls; too long is the 29
    minutes this exists to prevent."""
    assert 60.0 <= SHIPPED_STALL_S <= 600.0


@pytest.mark.asyncio
async def test_background_chatter_does_not_keep_a_dead_turn_alive():
    """THE bug this signal was narrowed for. The session log is shared:
    memory compaction and trigger bookkeeping keep writing to it. Watching
    the raw write count meant a turn whose CLI had died sat "progressing"
    for ten minutes while nothing about it moved."""
    logger = _Logger()

    async def _dead_turn():
        while True:                    # the turn itself does nothing
            await asyncio.sleep(0.01)

    async def _noise():
        for _ in range(200):           # …but the session log keeps growing
            await asyncio.sleep(0.005)
            logger.background()

    noise = asyncio.create_task(_noise())
    agent = _Agent(_dead_turn)
    with pytest.raises(asyncio.TimeoutError):
        await _run(agent, logger)
    noise.cancel()

    assert agent.cancelled is True


@pytest.mark.asyncio
async def test_turn_events_still_count_as_progress():
    """The narrowing must not make every long turn look dead."""
    logger = _Logger()

    async def _working():
        for _ in range(20):
            await asyncio.sleep(0.02)
            logger.bump()
        return {"output": "완료"}

    agent = _Agent(_working)
    assert await _run(agent, logger) == {"output": "완료"}
    assert agent.cancelled is False


def test_an_interactive_turn_is_not_given_the_batch_budget():
    """1800 s is a runaway-guard for a batch job, not a budget for a reply
    someone is watching — healthy turns here measured 9-17 s."""
    assert 60.0 <= mod._INTERACTIVE_TIMEOUT_S <= 1800.0
    assert mod._INTERACTIVE_TIMEOUT_S < 1800.0
