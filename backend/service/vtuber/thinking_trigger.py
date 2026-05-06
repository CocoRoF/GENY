"""
Thinking Trigger Service
========================

Manages when the VTuber should initiate self-driven thinking —
idle reflections, scheduled check-ins, or event-driven observations.

The service runs a lightweight background loop that periodically
checks whether any VTuber session should fire a [THINKING_TRIGGER].

Per-session presets (cycle 20260506)
------------------------------------
Each session can attach a :class:`TriggerPresetManifest` via
:meth:`attach_preset`. When attached, the runtime reads timing,
phases, categories, and prompts from the preset; when no preset is
attached the bundled :func:`default_manifest` from
:mod:`service.trigger_preset.defaults` provides identical behaviour
to the historical hardcoded ladder. Live reload is via a cheap
version counter on :class:`TriggerPresetService` — every fire reads
``svc.get_version()`` and reloads the cached manifest if it changed.
"""

from __future__ import annotations

import asyncio
import math
import os
import random
import time
from logging import getLogger
from typing import Dict, List, Optional, Set, Tuple

from service.tick import TickEngine, TickSpec
from service.trigger_preset.defaults import default_manifest
from service.trigger_preset.schemas import (
    TriggerCategory,
    TriggerPhase,
    TriggerPresetManifest,
)

logger = getLogger(__name__)

# TickEngine spec cadence — the spec polls every 30s; per-session
# adaptive backoff is enforced inside the handler (``scan_all``).
_TICK_INTERVAL_SECONDS = 30.0
_TICK_JITTER_SECONDS = 2.0
_TICK_SPEC_NAME = "thinking_trigger"

# Cycle 20260506 — back-compat shim for callers (tests + legacy
# imports) that referenced the old module-level constant. The
# canonical value now lives on the :class:`TriggerCategory` for
# ``sub_worker_working`` inside the bundled default manifest; this
# alias keeps the original number visible at the module surface so
# tests and operator scripts that grep the source still resolve.
_SUB_WORKER_WORKING_COOLDOWN_SECONDS = 90.0


# ── Default manifest (singleton, lazy) ────────────────────────────
# The bundled defaults are immutable for the lifetime of the
# process; cache one shared instance to avoid rebuilding the (large)
# prompt catalog every fire.

_DEFAULT_MANIFEST_INSTANCE: Optional[TriggerPresetManifest] = None


def _get_default_manifest() -> TriggerPresetManifest:
    global _DEFAULT_MANIFEST_INSTANCE
    if _DEFAULT_MANIFEST_INSTANCE is None:
        _DEFAULT_MANIFEST_INSTANCE = default_manifest()
    return _DEFAULT_MANIFEST_INSTANCE


# ── Condition evaluation context ──────────────────────────────────
# Bundled into a small dataclass-like dict at fire-time so each
# category's condition gates evaluate against a frozen snapshot of
# session state — no repeated lookups inside the filter loop.


def _build_condition_context(
    *,
    session_id: str,
    count: int,
    linked_id: Optional[str],
    sub_worker_busy: bool,
    current_hour: int,
    manifest: TriggerPresetManifest,
    last_category_fire: Dict[str, float],
    now: float,
) -> Dict:
    """Snapshot the inputs that category conditions read at fire-time."""
    bounds = manifest.time_boundaries
    if bounds.morning_start <= current_hour < bounds.afternoon_start:
        time_window = "morning"
    elif bounds.afternoon_start <= current_hour < bounds.evening_start:
        time_window = "afternoon"
    elif bounds.evening_start <= current_hour < bounds.night_start:
        time_window = "evening"
    else:
        time_window = "night"
    return {
        "session_id": session_id,
        "count": count,
        "linked_id": linked_id,
        "sub_worker_busy": sub_worker_busy,
        "time_window": time_window,
        "last_category_fire": last_category_fire,
        "now": now,
    }


def _category_eligible(category: TriggerCategory, ctx: Dict) -> bool:
    """Return ``True`` if the category passes every active condition gate."""
    cond = category.conditions

    if cond.requires_sub_worker_busy and not ctx["sub_worker_busy"]:
        return False
    if cond.requires_sub_worker_idle:
        if ctx["linked_id"] is None or ctx["sub_worker_busy"]:
            return False
    if cond.time_window is not None and cond.time_window != ctx["time_window"]:
        return False
    if cond.min_consecutive is not None and ctx["count"] < cond.min_consecutive:
        return False
    if cond.max_consecutive is not None and ctx["count"] > cond.max_consecutive:
        return False

    # Per-category cooldown — applies regardless of conditions, so that a
    # high-priority category doesn't dominate consecutive ticks.
    if category.cooldown_seconds and category.cooldown_seconds > 0:
        last = ctx["last_category_fire"].get(category.id, 0.0)
        if (ctx["now"] - last) < category.cooldown_seconds:
            return False

    return True


# ── Phase + roulette helpers ──────────────────────────────────────


def _select_phase(
    manifest: TriggerPresetManifest, count: int
) -> Optional[TriggerPhase]:
    """First phase whose [min, max] range covers ``count``.

    A phase with ``max_consecutive=None`` matches every count >= its
    floor, so place such phases last in the manifest list. Returns
    ``None`` only when the preset has zero phases (degenerate but
    accepted as a way to disable trigger firing without flipping the
    enabled flag).
    """
    for phase in manifest.phases:
        if count < phase.min_consecutive:
            continue
        if (
            phase.max_consecutive is not None
            and count > phase.max_consecutive
        ):
            continue
        return phase
    return None


def _roulette(
    eligible: List[Tuple[TriggerCategory, float]]
) -> Optional[TriggerCategory]:
    """Weighted pick from a list of ``(category, weight)`` tuples."""
    if not eligible:
        return None
    total = sum(w for _, w in eligible if w > 0)
    if total <= 0:
        return None
    roll = random.random() * total
    cumulative = 0.0
    for cat, w in eligible:
        if w <= 0:
            continue
        cumulative += w
        if roll < cumulative:
            return cat
    # Float-precision fallback — return the last positive-weight entry.
    return eligible[-1][0]


def _pick_prompt(category: TriggerCategory, locale: str) -> str:
    """Random prompt from ``category.prompts`` with EN fallback."""
    prompts = category.prompts.get(locale)
    if not prompts:
        prompts = category.prompts.get("en")
    if not prompts:
        return f"[THINKING_TRIGGER:{category.id}] (no prompt configured)"
    return random.choice(prompts)


class ThinkingTriggerService:
    """Background service that fires [THINKING_TRIGGER] for idle VTuber sessions."""

    def __init__(
        self,
        idle_threshold: Optional[float] = None,
        max_idle_threshold: Optional[float] = None,
        engine: Optional[TickEngine] = None,
    ) -> None:
        # Reuse an injected TickEngine (shared across services in X2-5/X2-6)
        # or own one ourselves.
        self._engine = engine if engine is not None else TickEngine()
        self._owns_engine = engine is None
        self._running = False
        # session_id → last_activity_epoch  (updated externally)
        self._activity: Dict[str, float] = {}
        # Sessions explicitly disabled by user
        self._disabled_sessions: Set[str] = set()
        # session_id → consecutive trigger count (resets on user activity)
        self._consecutive_triggers: Dict[str, int] = {}
        # session_id → category_id → last fire epoch (drives per-category
        # cooldown gates).
        self._last_category_fire: Dict[str, Dict[str, float]] = {}
        # session_id → preset_id (None = use bundled defaults)
        self._session_preset_id: Dict[str, Optional[str]] = {}
        # preset_id → (version_observed, cached manifest). Invalidated
        # when ``TriggerPresetService.get_version()`` ticks past the
        # cached version.
        self._preset_cache: Dict[str, Tuple[int, TriggerPresetManifest]] = {}

        # Back-compat: older callers (and unit tests pre-cycle 20260506)
        # passed ``idle_threshold`` / ``max_idle_threshold`` to override
        # the timing constants. The new model is to read timing from a
        # preset manifest, so we honour these kwargs by cloning the
        # bundled default manifest and patching its timing block.
        # Without an override the singleton default is shared.
        if idle_threshold is None and max_idle_threshold is None:
            self._instance_default_manifest: Optional[
                TriggerPresetManifest
            ] = None
        else:
            base = _get_default_manifest().model_copy(deep=True)
            timing = base.timing.model_copy(
                update={
                    **(
                        {"base_idle_seconds": float(idle_threshold)}
                        if idle_threshold is not None
                        else {}
                    ),
                    **(
                        {"max_idle_seconds": float(max_idle_threshold)}
                        if max_idle_threshold is not None
                        else {}
                    ),
                }
            )
            base = base.model_copy(update={"timing": timing})
            self._instance_default_manifest = base

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Register the tick spec and start the engine (if owned)."""
        if self._running:
            return
        self._engine.register(
            TickSpec(
                name=_TICK_SPEC_NAME,
                interval=_TICK_INTERVAL_SECONDS,
                handler=self.scan_all,
                jitter=_TICK_JITTER_SECONDS,
            )
        )
        if self._owns_engine:
            await self._engine.start()
        self._running = True
        logger.info(
            "ThinkingTriggerService started (tick=%ss±%ss)",
            _TICK_INTERVAL_SECONDS,
            _TICK_JITTER_SECONDS,
        )

    async def stop(self) -> None:
        """Unregister the spec; stop the engine only if we own it."""
        if not self._running:
            return
        self._running = False
        self._engine.unregister(_TICK_SPEC_NAME)
        if self._owns_engine:
            await self._engine.stop()
        self._activity.clear()
        self._disabled_sessions.clear()
        self._consecutive_triggers.clear()
        self._last_category_fire.clear()
        self._session_preset_id.clear()
        self._preset_cache.clear()
        logger.info("ThinkingTriggerService stopped")

    # ------------------------------------------------------------------
    # External hooks (called by other components)
    # ------------------------------------------------------------------

    def record_activity(self, session_id: str) -> None:
        """Record that a VTuber session just had user interaction."""
        self._activity[session_id] = time.time()
        # User activity resets adaptive frequency back to base
        self._consecutive_triggers.pop(session_id, None)

    def attach_preset(
        self, session_id: str, preset_id: Optional[str]
    ) -> None:
        """Bind *session_id* to a stored trigger preset (or ``None`` to
        revert the session to the bundled default behaviour).

        Idempotent — calling with the same ``preset_id`` is a no-op.
        Does *not* reset ``consecutive_triggers``: the new preset
        applies on the next tick using the existing count, so a
        mid-conversation swap doesn't double-fire.
        """
        if preset_id is None:
            self._session_preset_id.pop(session_id, None)
        else:
            self._session_preset_id[session_id] = preset_id
        logger.info(
            "ThinkingTrigger preset for %s → %s",
            session_id, preset_id or "(default)",
        )

    def get_attached_preset(self, session_id: str) -> Optional[str]:
        return self._session_preset_id.get(session_id)

    def unregister(self, session_id: str) -> None:
        """Remove a session from tracking (e.g. on deletion)."""
        self._activity.pop(session_id, None)
        self._disabled_sessions.discard(session_id)
        self._consecutive_triggers.pop(session_id, None)
        self._last_category_fire.pop(session_id, None)
        self._session_preset_id.pop(session_id, None)

    def enable(self, session_id: str) -> None:
        """Enable thinking trigger for a session."""
        self._disabled_sessions.discard(session_id)
        logger.info("ThinkingTrigger enabled for %s", session_id)

    def disable(self, session_id: str) -> None:
        """Disable thinking trigger for a session."""
        self._disabled_sessions.add(session_id)
        logger.info("ThinkingTrigger disabled for %s", session_id)

    def is_enabled(self, session_id: str) -> bool:
        """Check if thinking trigger is enabled for a session."""
        return session_id not in self._disabled_sessions

    def get_status(self, session_id: str) -> dict:
        """Return thinking trigger status for a session."""
        manifest = self._resolve_manifest(session_id)
        return {
            "enabled": self.is_enabled(session_id),
            "registered": session_id in self._activity,
            "consecutive_triggers": self._consecutive_triggers.get(session_id, 0),
            "current_threshold_seconds": round(
                self._get_adaptive_threshold(session_id), 1
            ),
            "base_threshold_seconds": manifest.timing.base_idle_seconds,
            "max_threshold_seconds": manifest.timing.max_idle_seconds,
            "preset_id": self._session_preset_id.get(session_id),
            "preset_enabled": manifest.enabled,
        }

    # ------------------------------------------------------------------
    # Manifest resolution + cache
    # ------------------------------------------------------------------

    def _resolve_manifest(self, session_id: str) -> TriggerPresetManifest:
        """Active manifest for a session — preset (if attached + alive)
        or the default fallback.

        Fallback resolution prefers the instance-level default manifest
        (set when the constructor received ``idle_threshold`` /
        ``max_idle_threshold`` overrides) over the shared singleton.

        Cache key: ``preset_id``. Cache invalidator: the preset
        service's monotonic ``version`` counter — bumped on every
        mutation. Reading the version is a single attribute fetch, so
        the per-fire cost is negligible.
        """
        fallback = self._instance_default_manifest or _get_default_manifest()

        preset_id = self._session_preset_id.get(session_id)
        if not preset_id:
            return fallback

        try:
            from service.trigger_preset import get_trigger_preset_service

            svc = get_trigger_preset_service()
        except Exception:  # noqa: BLE001 — service module not yet wired
            return fallback

        if svc is None:
            return fallback

        current_version = svc.get_version()
        cached = self._preset_cache.get(preset_id)
        if cached is not None and cached[0] == current_version:
            return cached[1]

        record = svc.get(preset_id)
        if record is None:
            # Preset was deleted — clear the binding so subsequent fires
            # use the default manifest, and the next tick observes the
            # session as default-bound rather than re-resolving an absent
            # record over and over.
            self._session_preset_id.pop(session_id, None)
            self._preset_cache.pop(preset_id, None)
            return fallback

        self._preset_cache[preset_id] = (current_version, record.manifest)
        return record.manifest

    @staticmethod
    def _safe_inbox_unread_count(session_id: str) -> int:
        """Return the unread inbox count for *session_id*, swallowing errors.

        Used by ``scan_all`` and ``_fire_trigger`` to choose between
        firing a synthetic thinking trigger and draining a real queued
        message (typically a ``[SUB_WORKER_RESULT]`` from the linked
        Sub-Worker that landed while the VTuber was busy). Any failure
        in inbox lookup is logged at debug level and treated as
        "0 unread" so a misbehaving inbox subsystem never blocks the
        thinking-trigger loop.
        """
        try:
            from service.chat.inbox import get_inbox_manager
            return int(get_inbox_manager().unread_count(session_id))
        except Exception:
            logger.debug(
                "inbox unread_count failed for %s", session_id, exc_info=True,
            )
            return 0

    @staticmethod
    async def _kick_inbox_drain(session_id: str) -> None:
        """Run the agent-executor drain for *session_id*, swallowing errors."""
        try:
            from service.execution.agent_executor import _drain_inbox
            await _drain_inbox(session_id)
        except Exception:
            logger.debug(
                "inbox drain kick failed for %s", session_id, exc_info=True,
            )

    def _get_adaptive_threshold(self, session_id: str) -> float:
        """Calculate adaptive idle threshold using log scale.

        Grows from ``base_idle_seconds`` toward ``max_idle_seconds`` as
        consecutive triggers accumulate without user interaction —
        scale set by ``adaptive_scale_triggers``. All three knobs come
        from the active manifest (preset or default).
        """
        manifest = self._resolve_manifest(session_id)
        base = manifest.timing.base_idle_seconds
        max_t = manifest.timing.max_idle_seconds
        scale_n = max(1, manifest.timing.adaptive_scale_triggers)
        count = self._consecutive_triggers.get(session_id, 0)
        if count <= 0:
            return base
        scale = math.log1p(count) / math.log1p(scale_n)
        scale = min(scale, 1.0)
        return base + (max_t - base) * scale

    # ------------------------------------------------------------------
    # Tick handler
    # ------------------------------------------------------------------

    async def scan_all(self) -> None:
        """One tick — fan out triggers for sessions whose idle time exceeds
        their current adaptive threshold.

        Registered as ``TickSpec(name="thinking_trigger")``. The spec
        cadence is fixed at 30s; per-session adaptive backoff is
        enforced here via ``_get_adaptive_threshold``. A session whose
        active manifest sets ``enabled=False`` is skipped without
        clearing its consecutive count, so toggling the preset back
        on resumes the same idle-stage cadence the session was in.
        """
        now = time.time()

        trigger_tasks = []
        for sid, last in list(self._activity.items()):
            if sid in self._disabled_sessions:
                continue

            manifest = self._resolve_manifest(sid)
            if not manifest.enabled:
                continue

            # Inbox priority — see :meth:`_fire_trigger` for rationale.
            if self._safe_inbox_unread_count(sid) > 0:
                trigger_tasks.append((sid, self._kick_inbox_drain(sid)))
                self._activity[sid] = now
                continue

            idle = now - last
            threshold = self._get_adaptive_threshold(sid)
            if idle < threshold:
                continue

            trigger_tasks.append((sid, self._fire_trigger(sid)))
            # Reset to avoid immediate re-fire
            self._activity[sid] = now

        # Await all triggers concurrently
        if trigger_tasks:
            results = await asyncio.gather(
                *[coro for _, coro in trigger_tasks],
                return_exceptions=True,
            )
            for (sid, _), result in zip(trigger_tasks, results):
                if isinstance(result, Exception):
                    logger.debug("Trigger failed for %s: %s", sid, result)

    async def _fire_trigger(self, session_id: str) -> None:
        """Send a context-aware [THINKING_TRIGGER] to the VTuber session.

        If the session has a chat_room_id, the response is also saved
        to the chat room so it appears in the VTuber chat panel in real-time.
        """
        try:
            from service.execution.agent_executor import (
                AlreadyExecutingError,
                AgentNotAliveError,
                AgentNotFoundError,
                execute_command,
                is_executing,
            )

            # Last-mile inbox guard — the unread count may have flipped
            # to non-zero between `scan_all` and now (e.g. a Sub-Worker
            # finished mid-tick). Prefer real inbox content over a
            # synthetic idle prompt so the VTuber never narrates
            # "still waiting" while a queued result is in the inbox.
            if self._safe_inbox_unread_count(session_id) > 0:
                logger.debug(
                    "thinking trigger deferred — inbox has unread for %s",
                    session_id,
                )
                await self._kick_inbox_drain(session_id)
                return

            prompt = self._build_trigger_prompt(session_id, is_executing)
            if prompt is None:
                # Manifest disabled or no eligible category — skip silently.
                return

            # Extract category for logging (prompt starts with [THINKING_TRIGGER:xxx])
            import re
            _tag_match = re.search(r'\[(THINKING|ACTIVITY)_TRIGGER(?::\w+)?\]', prompt)
            _tag_end = _tag_match.end() if _tag_match else 20
            prompt_preview = prompt[_tag_end:_tag_end + 50].strip().replace("\n", " ")

            # Activity triggers delegate to Sub-Worker — allow more time (10 min).
            # Thinking triggers are short reflections — 3 min is plenty.
            is_activity = prompt.startswith("[ACTIVITY_TRIGGER]")
            trigger_timeout = 600.0 if is_activity else 180.0

            source_metadata = self._build_reflection_metadata(prompt)

            result = await execute_command(
                session_id, prompt,
                is_trigger=True,
                timeout=trigger_timeout,
                source_metadata=source_metadata,
            )

            # Increment consecutive count (drives adaptive backoff)
            self._consecutive_triggers[session_id] = (
                self._consecutive_triggers.get(session_id, 0) + 1
            )

            # Save response to chat room (if available)
            if result.success and result.output and result.output.strip():
                self._save_to_chat_room(session_id, result)
                logger.info(
                    "Thinking trigger fired for %s (output=%d chars, consecutive=%d, "
                    "next_threshold=%.0fs, locale=%s, prompt='%s')",
                    session_id, len(result.output),
                    self._consecutive_triggers.get(session_id, 0),
                    self._get_adaptive_threshold(session_id),
                    self._get_locale(), prompt_preview,
                )
            else:
                logger.info(
                    "Thinking trigger fired for %s (success=%s, output_len=%s, "
                    "consecutive=%d, prompt='%s')",
                    session_id, result.success,
                    len(result.output) if result.output else 0,
                    self._consecutive_triggers.get(session_id, 0),
                    prompt_preview,
                )

        except AlreadyExecutingError:
            logger.debug("Thinking trigger skipped (busy): %s", session_id)
        except AgentNotFoundError:
            logger.debug("Thinking trigger: session gone, unregistering %s", session_id)
            self.unregister(session_id)
        except AgentNotAliveError:
            logger.debug("Thinking trigger skipped (not alive, will retry): %s", session_id)
            self._consecutive_triggers[session_id] = (
                self._consecutive_triggers.get(session_id, 0) + 1
            )
        except Exception:
            logger.debug("Thinking trigger failed for %s", session_id, exc_info=True)
            self._consecutive_triggers[session_id] = (
                self._consecutive_triggers.get(session_id, 0) + 1
            )

    @staticmethod
    def _build_reflection_metadata(prompt: str):
        """InteractionEvent metadata for a self-prompted reflection turn.

        The prompt always begins with one of:

          [THINKING_TRIGGER:<category>] ...
          [ACTIVITY_TRIGGER] ...
          [ACTIVITY_TRIGGER:<category>] ...

        We extract the tag once and stamp the metadata
        ``payload.trigger_category`` accordingly. Direction is
        ``internal`` (the VTuber prompted itself);
        ``counterpart_id`` / ``counterpart_role`` are ``self`` /
        ``self``. Returns ``None`` if the prompt doesn't match a
        recognised trigger shape — the parser fallback in
        ``_invoke_pipeline`` will then noop (role==internal_trigger
        with no parser path) which is fine.
        """
        import re as _re

        from service.memory.interaction_event import (
            CounterpartRole,
            Direction,
            Kind,
            make_event_metadata,
        )

        m = _re.match(r"^\[(THINKING_TRIGGER|ACTIVITY_TRIGGER)(?::(\w+))?\]", prompt)
        if not m:
            return None
        family = m.group(1).lower()
        category = m.group(2) or family
        return make_event_metadata(
            kind=Kind.REFLECTION,
            direction=Direction.INTERNAL,
            counterpart_id="self",
            counterpart_role=CounterpartRole.SELF,
            payload={
                "trigger_family": family,
                "trigger_category": category,
            },
        )

    def _save_to_chat_room(self, session_id: str, result) -> None:
        """Persist the trigger response to the session's chat room.

        Also notifies SSE listeners so the VTuber chat panel updates live.
        """
        try:
            from service.utils.text_sanitizer import sanitize_for_display
            cleaned = sanitize_for_display(result.output) if result.success else ""
            if not cleaned:
                return

            from service.executor import get_agent_session_manager
            agent = get_agent_session_manager().get_agent(session_id)
            if not agent:
                logger.warning("[ThinkingTrigger] No agent found for %s, skipping chat save", session_id)
                return

            chat_room_id = getattr(agent, '_chat_room_id', None)
            if not chat_room_id:
                logger.warning("[ThinkingTrigger] No chat_room_id on agent %s, skipping chat save", session_id)
                return

            from service.chat.conversation_store import get_chat_store
            store = get_chat_store()

            session_name = getattr(agent, '_session_name', None) or session_id
            role_val = getattr(agent, '_role', None)
            role = role_val.value if hasattr(role_val, 'value') else str(role_val or 'vtuber')

            msg = store.add_message(chat_room_id, {
                "type": "agent",
                "content": cleaned,
                "session_id": session_id,
                "session_name": session_name,
                "role": role,
                "duration_ms": result.duration_ms,
                "cost_usd": result.cost_usd,
                "source": "thinking_trigger",
            })

            logger.info(
                "[ThinkingTrigger] Saved response to chat room %s (msg_id=%s, len=%d)",
                chat_room_id, msg.get("id", "?"), len(cleaned),
            )

            try:
                from controller.chat_controller import _notify_room
                _notify_room(chat_room_id)
            except Exception:
                logger.warning("[ThinkingTrigger] _notify_room failed for %s", chat_room_id, exc_info=True)

        except Exception:
            logger.warning("[ThinkingTrigger] Failed to save trigger response to chat room", exc_info=True)

    def _build_trigger_prompt(
        self, session_id: str, is_executing_fn
    ) -> Optional[str]:
        """Select a context-aware, locale-aware trigger prompt.

        Resolution path:

        1. Pull the active manifest (preset or default fallback).
        2. Pick the phase whose ``[min, max]`` range covers the
           session's consecutive-trigger count.
        3. Filter that phase's ``events`` against each linked
           category's :class:`CategoryConditions` (sub-worker state,
           time window, consecutive bounds, per-category cooldown).
        4. Roulette-roll over the surviving (category, weight) pairs.
        5. Random-pick a prompt from the chosen category's
           ``prompts[locale]`` (with EN fallback).

        Returns ``None`` when the manifest is disabled, has no
        matching phase, or every event was filtered out.
        """
        manifest = self._resolve_manifest(session_id)
        if not manifest.enabled:
            return None

        locale = self._get_locale()
        count = self._consecutive_triggers.get(session_id, 0)

        # Snapshot session state once for the condition-evaluation pass.
        linked_id, sub_worker_busy = self._probe_sub_worker_state(
            session_id, is_executing_fn
        )
        now = time.time()
        ctx = _build_condition_context(
            session_id=session_id,
            count=count,
            linked_id=linked_id,
            sub_worker_busy=sub_worker_busy,
            current_hour=self._current_hour(),
            manifest=manifest,
            last_category_fire=self._last_category_fire.setdefault(session_id, {}),
            now=now,
        )

        phase = _select_phase(manifest, count)
        if phase is None:
            return None

        # Index categories by id for O(1) lookup inside the filter loop.
        cat_index: Dict[str, TriggerCategory] = {
            c.id: c for c in manifest.categories
        }

        eligible: List[Tuple[TriggerCategory, float]] = []
        for ev in phase.events:
            cat = cat_index.get(ev.category_id)
            if cat is None:
                continue
            if ev.weight <= 0:
                continue
            if not _category_eligible(cat, ctx):
                continue
            eligible.append((cat, ev.weight))

        chosen = _roulette(eligible)
        if chosen is None:
            return None

        # Mark cooldown so the next tick filters this category until the
        # window elapses.
        if chosen.cooldown_seconds and chosen.cooldown_seconds > 0:
            self._last_category_fire.setdefault(session_id, {})[chosen.id] = now

        return _pick_prompt(chosen, locale)

    @staticmethod
    def _probe_sub_worker_state(
        session_id: str, is_executing_fn
    ) -> Tuple[Optional[str], bool]:
        """Return ``(linked_session_id, sub_worker_busy)`` for *session_id*.

        Both fields swallow errors and degrade to ``(None, False)`` —
        the sub-worker integration is ancillary to the trigger loop.
        """
        try:
            from service.executor import get_agent_session_manager

            agent = get_agent_session_manager().get_agent(session_id)
            if agent is None:
                return None, False
            linked_id = getattr(agent, "linked_session_id", None)
            if not linked_id:
                return None, False
            return linked_id, bool(is_executing_fn(linked_id))
        except Exception:
            return None, False

    # ------------------------------------------------------------------
    # Locale + clock helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _get_locale() -> str:
        """Return the current system locale (en or ko)."""
        lang = os.environ.get("GENY_LANGUAGE", "en")
        return lang if lang in ("en", "ko") else "en"

    @staticmethod
    def _current_hour() -> int:
        """KST hour-of-day for ``time_window`` condition evaluation."""
        from service.utils.utils import now_kst
        return now_kst().hour


# ============================================================================
# Module-level singleton
# ============================================================================

_instance: Optional[ThinkingTriggerService] = None


def get_thinking_trigger_service() -> ThinkingTriggerService:
    """Get or create the singleton ThinkingTriggerService."""
    global _instance
    if _instance is None:
        _instance = ThinkingTriggerService()
    return _instance
