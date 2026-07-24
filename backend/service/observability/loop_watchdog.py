"""Event-loop watchdog — turns silent loop blocks into actionable stack dumps.

Three separate production incidents (2026-07-09 run_coro_sync deadlock,
2026-07-21 Synapse SQLite freeze, 2026-07-25 194s session-wake stall) shared
one symptom: the asyncio loop stopped serving for minutes with ZERO log
output, and diagnosis required guesswork after the fact. This watchdog makes
the next one self-diagnosing:

* A daemon thread pings the loop with ``call_soon_threadsafe`` every
  ``interval`` seconds.
* If the loop doesn't run the ping within ``threshold`` seconds, the watchdog
  logs CRITICAL with the **current Python stack of every thread** — including
  the loop thread, which shows exactly which synchronous call is squatting on
  the loop.
* A cooldown keeps a long block from flooding the log; recovery is logged so
  the block's total duration is measurable.

Pure stdlib, read-only, no effect on the loop beyond one no-op callback per
interval. Cost: one daemon thread.
"""

from __future__ import annotations

import logging
import sys
import threading
import time
import traceback
from typing import Optional

logger = logging.getLogger(__name__)

_watchdog: Optional["LoopWatchdog"] = None


class LoopWatchdog:
    def __init__(self, loop, *, interval: float = 5.0,
                 threshold: float = 10.0, dump_cooldown: float = 60.0) -> None:
        self._loop = loop
        self._interval = interval
        self._threshold = threshold
        self._dump_cooldown = dump_cooldown
        self._pong = threading.Event()
        self._stop = threading.Event()
        self._blocked_since: Optional[float] = None
        self._last_dump = 0.0
        self._thread = threading.Thread(
            target=self._run, name="loop-watchdog", daemon=True)

    def start(self) -> None:
        self._thread.start()
        logger.info("loop-watchdog armed (threshold=%.0fs)", self._threshold)

    def stop(self) -> None:
        self._stop.set()

    # ── internals ────────────────────────────────────────────────────
    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self._pong.clear()
            try:
                self._loop.call_soon_threadsafe(self._pong.set)
            except RuntimeError:
                return  # loop closed — shut down quietly
            if self._pong.wait(self._threshold):
                if self._blocked_since is not None:
                    blocked_for = time.monotonic() - self._blocked_since
                    logger.warning(
                        "event loop RECOVERED after ~%.1fs block", blocked_for)
                    self._blocked_since = None
                continue
            # Loop unresponsive past threshold.
            now = time.monotonic()
            if self._blocked_since is None:
                self._blocked_since = now - self._threshold
            if now - self._last_dump >= self._dump_cooldown:
                self._last_dump = now
                self._dump_stacks(now - self._blocked_since)

    def _dump_stacks(self, blocked_for: float) -> None:
        try:
            frames = sys._current_frames()
            names = {t.ident: t.name for t in threading.enumerate()}
            parts = [
                f"event loop BLOCKED for ~{blocked_for:.1f}s — "
                f"all-thread stack dump ({len(frames)} threads):"
            ]
            for ident, frame in frames.items():
                name = names.get(ident, f"tid={ident}")
                if name == "loop-watchdog":
                    continue
                stack = "".join(traceback.format_stack(frame, limit=25))
                parts.append(f"\n─── thread {name} ───\n{stack}")
            logger.critical("\n".join(parts))
        except Exception:  # noqa: BLE001 — diagnostics must never crash
            logger.exception("loop-watchdog stack dump failed")


def install_loop_watchdog(loop, *, interval: float = 5.0,
                          threshold: float = 10.0) -> LoopWatchdog:
    """Arm the watchdog on *loop* (idempotent — one instance per process)."""
    global _watchdog
    if _watchdog is not None:
        return _watchdog
    _watchdog = LoopWatchdog(loop, interval=interval, threshold=threshold)
    _watchdog.start()
    return _watchdog
