"""
USER_SHARED trigger debouncer for V2 STT-stream bursts.

Without this, every VAD-detected utterance fires its own
``[USER_SHARED]`` trigger the moment ``_auto_spotlight_for_event``
returns. A user speaking three sentences with 1.2 s gaps lands three
parallel trigger executions — and the persona produces three short,
disjointed replies instead of one coherent reaction.

This module coalesces consecutive STT-stream spotlight items per
``(user_id, session_id)`` key:

  * Each ``coalesce_user_shared_trigger(item)`` call cancels the
    pending burst timer for that session, replaces the buffered
    "latest item id", and reschedules a fresh sleep.
  * After ``COALESCE_WINDOW_SECONDS`` of silence (default 3 s, env
    override ``GENY_STT_STREAM_COALESCE_WINDOW_S``) the timer task
    fires exactly ONE ``fire_user_shared_trigger_async`` call against
    the most recent item.
  * The persona's per-turn ``[Spotlight Context]`` block already
    carries every individual utterance from the burst — the
    coalesced trigger just gives the persona ONE invitation to react,
    and the surrounding context shows the full sequence of utterances
    it has been overhearing.

Only ambient ``vtuber_stt_stream`` items go through this path.
Deliberate manual shares (Share-with-VTuber button, drag-drop file,
microphone_record Record button) still call
``fire_user_shared_trigger_async`` directly — the user explicitly
asked for that one trigger to fire.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from logging import getLogger
from typing import Dict, Optional, Tuple

from .types import SpotlightItem

logger = getLogger(__name__)


COALESCE_WINDOW_SECONDS: float = float(
    os.environ.get("GENY_STT_STREAM_COALESCE_WINDOW_S", "3.0")
)

# (user_id, session_id) → BurstState.
_SessionKey = Tuple[str, str]


@dataclass(slots=True)
class _BurstState:
    """Per-session coalescing state.

    ``latest_item`` always holds the most recent ambient share we've
    seen since the timer was last armed; that's the item the
    coalesced trigger will fire against. ``count`` is just for log
    visibility — it shows the operator how many utterances landed in
    the burst.
    """

    latest_item: SpotlightItem
    count: int = 1
    timer: Optional[asyncio.Task] = None
    # Cumulative excerpt of the burst — joined with linebreaks. Lets
    # the trigger composer surface the full overheard sequence even
    # if only the *last* spotlight item ends up driving the prompt.
    excerpts: list[str] = field(default_factory=list)


_states: Dict[_SessionKey, _BurstState] = {}
_lock = asyncio.Lock()


def _state_key(item: SpotlightItem) -> _SessionKey:
    """``session_id`` may be None for user-wide shares — bucket those
    separately so they don't collide with regular sessions."""
    return (item.user_id or "", item.session_id or "")


async def coalesce_user_shared_trigger(item: SpotlightItem) -> None:
    """Schedule (or extend) a debounced ``[USER_SHARED]`` trigger for
    *item*'s session.

    The function returns immediately — the actual trigger fires on a
    background asyncio task after the silence window elapses.
    Best-effort: never raises into the caller.
    """
    if not item.session_id:
        # Without a session there's no agent to trigger; just no-op.
        return

    key = _state_key(item)
    async with _lock:
        state = _states.get(key)
        if state is None:
            state = _BurstState(latest_item=item)
            _states[key] = state
        else:
            state.latest_item = item
            state.count += 1
            if state.timer is not None and not state.timer.done():
                state.timer.cancel()
        if item.excerpt:
            state.excerpts.append(item.excerpt)
        state.timer = asyncio.create_task(
            _fire_after_window(key),
            name=f"whiteboard.stt_burst_coalesce[{key[1][:8]}]",
        )


async def _fire_after_window(key: _SessionKey) -> None:
    """Sleep for the coalesce window then fire the trigger for the
    latest item this session accumulated.

    Cancelled the moment another ``coalesce_user_shared_trigger`` call
    arrives for the same session — the next call schedules a fresh
    sleep and a new task takes over.
    """
    try:
        await asyncio.sleep(COALESCE_WINDOW_SECONDS)
    except asyncio.CancelledError:
        return

    # Pull the state out and fire. The lock guards against a racing
    # ``coalesce_user_shared_trigger`` that's about to schedule a new
    # timer — we hand off the in-flight item before clearing.
    async with _lock:
        state = _states.pop(key, None)
    if state is None:
        return

    if state.count > 1:
        logger.info(
            "[stt_burst] coalesced %d utterances for session %s → one trigger",
            state.count,
            key[1][:12],
        )

    try:
        from .user_shared_trigger import fire_user_shared_trigger_async
        # The trigger function returns the scheduled Task or None;
        # we drop the return value — the task tracker holds the
        # reference for us.
        fire_user_shared_trigger_async(state.latest_item)
    except Exception:  # noqa: BLE001
        logger.warning(
            "[stt_burst] firing trigger failed for session %s",
            key[1][:12], exc_info=True,
        )


async def cancel_pending_for_session(
    user_id: str, session_id: str,
) -> Optional[SpotlightItem]:
    """Test / shutdown hook — cancel any pending burst for the given
    session and return the would-have-fired item (or None)."""
    key: _SessionKey = (user_id or "", session_id or "")
    async with _lock:
        state = _states.pop(key, None)
        if state is None:
            return None
        if state.timer is not None and not state.timer.done():
            state.timer.cancel()
        return state.latest_item


async def _drain_for_tests() -> None:
    """Cancel every pending timer. Used between tests so leftover
    asyncio.Tasks don't bleed into the next case."""
    async with _lock:
        for state in list(_states.values()):
            if state.timer is not None and not state.timer.done():
                state.timer.cancel()
        _states.clear()
