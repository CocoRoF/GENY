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
categories, and prompts from the preset; when no preset is attached
the bundled :func:`default_manifest` provides identical behaviour to
the historical hardcoded ladder. Live reload is via a cheap version
counter on :class:`TriggerPresetService` — every fire reads
``svc.get_version()`` and reloads the cached manifest if it changed.

Schema (cycle 20260507 redesign)
--------------------------------
Categories carry consec range as a regular condition; phases were
removed. The runtime fires by:

  1. matching → all categories whose conditions hold
  2. category roulette by ``Category.weight``
  3. prompt roulette by per-prompt weight inside the picked cat
  4. render via :func:`schemas.render_prompt`
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
    PromptRef,
    TriggerCategory,
    TriggerPresetManifest,
    TriggerPrompt,
    render_prompt,
)

logger = getLogger(__name__)

# TickEngine spec cadence — the spec polls every 30s; per-session
# adaptive backoff is enforced inside the handler (``scan_all``).
_TICK_INTERVAL_SECONDS = 30.0
_TICK_JITTER_SECONDS = 2.0
_TICK_SPEC_NAME = "thinking_trigger"

# Back-compat shim for callers (tests + legacy imports) that referenced
# the old module-level constant. The canonical value now lives on the
# bundled default manifest's ``sub_worker_working`` category.
_SUB_WORKER_WORKING_COOLDOWN_SECONDS = 90.0


# ── Default manifest (singleton, lazy) ────────────────────────────

_DEFAULT_MANIFEST_INSTANCE: Optional[TriggerPresetManifest] = None


def _get_default_manifest() -> TriggerPresetManifest:
    global _DEFAULT_MANIFEST_INSTANCE
    if _DEFAULT_MANIFEST_INSTANCE is None:
        _DEFAULT_MANIFEST_INSTANCE = default_manifest()
    return _DEFAULT_MANIFEST_INSTANCE


# ── Condition evaluation ─────────────────────────────────────────


def _category_eligible(
    category: TriggerCategory,
    *,
    consec: int,
    sub_worker_busy: bool,
    sub_worker_linked: bool,
    time_window: str,
    last_fire_at: float,
    now: float,
    screen_active: bool = False,
) -> bool:
    """Mirror of the FE simulator — condition gate for one category."""
    if consec < category.consec_min:
        return False
    if category.consec_max is not None and consec > category.consec_max:
        return False
    if category.requires_sub_worker_busy and not sub_worker_busy:
        return False
    if category.requires_sub_worker_idle:
        if not sub_worker_linked or sub_worker_busy:
            return False
    if getattr(category, "requires_screen_active", False) and not screen_active:
        return False
    if (
        category.time_window is not None
        and category.time_window != time_window
    ):
        return False
    if category.cooldown_seconds and category.cooldown_seconds > 0:
        if (now - last_fire_at) < category.cooldown_seconds:
            return False
    return True


def _resolve_time_window(
    manifest: TriggerPresetManifest, hour: int
) -> str:
    bounds = manifest.time_boundaries
    if bounds.morning_start <= hour < bounds.afternoon_start:
        return "morning"
    if bounds.afternoon_start <= hour < bounds.evening_start:
        return "afternoon"
    if bounds.evening_start <= hour < bounds.night_start:
        return "evening"
    return "night"


def _weighted_pick(items: List[Tuple[float, object]]) -> Optional[object]:
    """Roulette across (weight, item) tuples. Returns None if all zero."""
    total = sum(w for w, _ in items if w > 0)
    if total <= 0:
        return None
    roll = random.random() * total
    cumulative = 0.0
    for w, item in items:
        if w <= 0:
            continue
        cumulative += w
        if roll < cumulative:
            return item
    # Float-precision fallback.
    for w, item in reversed(items):
        if w > 0:
            return item
    return None


class ThinkingTriggerService:
    """Background service that fires [THINKING_TRIGGER] for idle VTuber sessions."""

    def __init__(
        self,
        idle_threshold: Optional[float] = None,
        max_idle_threshold: Optional[float] = None,
        engine: Optional[TickEngine] = None,
    ) -> None:
        self._engine = engine if engine is not None else TickEngine()
        self._owns_engine = engine is None
        self._running = False
        # session_id → last_activity_epoch  (updated externally)
        self._activity: Dict[str, float] = {}
        # Sessions explicitly disabled by user
        self._disabled_sessions: Set[str] = set()
        # session_id → consecutive trigger count (resets on user activity)
        self._consecutive_triggers: Dict[str, int] = {}
        # session_id → category_id → last fire epoch (cooldown gate).
        self._last_category_fire: Dict[str, Dict[str, float]] = {}
        # session_id → preset_id (None = use bundled defaults)
        self._session_preset_id: Dict[str, Optional[str]] = {}
        # preset_id → (version_observed, cached manifest).
        self._preset_cache: Dict[str, Tuple[int, TriggerPresetManifest]] = {}

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

    # ── Lifecycle ────────────────────────────────────────────

    async def start(self) -> None:
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

    # ── External hooks ──────────────────────────────────────

    def record_activity(self, session_id: str) -> None:
        self._activity[session_id] = time.time()
        self._consecutive_triggers.pop(session_id, None)

    def attach_preset(
        self, session_id: str, preset_id: Optional[str]
    ) -> None:
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
        self._activity.pop(session_id, None)
        self._disabled_sessions.discard(session_id)
        self._consecutive_triggers.pop(session_id, None)
        self._last_category_fire.pop(session_id, None)
        self._session_preset_id.pop(session_id, None)

    def enable(self, session_id: str) -> None:
        self._disabled_sessions.discard(session_id)
        logger.info("ThinkingTrigger enabled for %s", session_id)

    def disable(self, session_id: str) -> None:
        self._disabled_sessions.add(session_id)
        logger.info("ThinkingTrigger disabled for %s", session_id)

    def is_enabled(self, session_id: str) -> bool:
        return session_id not in self._disabled_sessions

    def get_status(self, session_id: str) -> dict:
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

    # ── Manifest resolution + cache ────────────────────────

    def _resolve_manifest(self, session_id: str) -> TriggerPresetManifest:
        # In-code default — last-resort when the preset service is unavailable
        # (early boot / tests / no DB). Still includes the screen category.
        fallback = self._instance_default_manifest or _get_default_manifest()

        explicit_id = self._session_preset_id.get(session_id)

        try:
            from service.trigger_preset import (
                DEFAULT_PRESET_ID,
                get_trigger_preset_service,
            )

            svc = get_trigger_preset_service()
        except Exception:  # noqa: BLE001
            return fallback

        if svc is None:
            return fallback

        # No explicit attach → resolve to the SEEDED default preset, so Geny's
        # provided default ("기본 (화면 관찰 포함)") is what actually runs and
        # editing it in 트리거 관리 affects every default session.
        effective_id = explicit_id or DEFAULT_PRESET_ID

        current_version = svc.get_version()
        cached = self._preset_cache.get(effective_id)
        if cached is not None and cached[0] == current_version:
            return cached[1]

        record = svc.get(effective_id)
        if record is None:
            # An explicitly-attached preset that vanished → stop chasing it.
            if explicit_id:
                self._session_preset_id.pop(session_id, None)
            self._preset_cache.pop(effective_id, None)
            return fallback

        self._preset_cache[effective_id] = (current_version, record.manifest)
        return record.manifest

    @staticmethod
    def _safe_inbox_unread_count(session_id: str) -> int:
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
        try:
            from service.execution.agent_executor import _drain_inbox
            await _drain_inbox(session_id)
        except Exception:
            logger.debug(
                "inbox drain kick failed for %s", session_id, exc_info=True,
            )

    def _get_adaptive_threshold(self, session_id: str) -> float:
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

    # ── Tick handler ────────────────────────────────────────

    async def scan_all(self) -> None:
        now = time.time()
        trigger_tasks = []
        # Sessions to consider: those with recorded activity PLUS any actively
        # sharing their screen. The latter must keep getting screen commentary
        # even if they were never registered via a normal turn (e.g. lazily
        # rehydrated after a restart) or the idle backoff has grown.
        screen_active: set = set()
        try:
            from service.vtuber.screen_observation import list_active_sessions
            screen_active = set(list_active_sessions())
        except Exception:  # noqa: BLE001
            screen_active = set()
        sids = set(self._activity) | screen_active
        for sid in sids:
            if sid in self._disabled_sessions:
                continue
            manifest = self._resolve_manifest(sid)
            if not manifest.enabled:
                continue
            if self._safe_inbox_unread_count(sid) > 0:
                trigger_tasks.append((sid, self._kick_inbox_drain(sid)))
                self._activity[sid] = now
                continue
            last = self._activity.get(sid, 0.0)
            idle = now - last
            # While sharing the screen, IGNORE the adaptive backoff — commentary
            # should keep flowing (the screen category's own cooldown rate-limits
            # it). Otherwise use the growing adaptive threshold as before.
            if sid in screen_active:
                threshold = manifest.timing.base_idle_seconds
            else:
                threshold = self._get_adaptive_threshold(sid)
            if idle < threshold:
                continue
            trigger_tasks.append((sid, self._fire_trigger(sid)))
            self._activity[sid] = now
        if trigger_tasks:
            results = await asyncio.gather(
                *[coro for _, coro in trigger_tasks],
                return_exceptions=True,
            )
            for (sid, _), result in zip(trigger_tasks, results):
                if isinstance(result, Exception):
                    logger.debug("Trigger failed for %s: %s", sid, result)

    async def _fire_trigger(self, session_id: str) -> None:
        try:
            from service.execution.agent_executor import (
                AlreadyExecutingError,
                AgentNotAliveError,
                AgentNotFoundError,
                execute_command,
                is_executing,
            )

            if self._safe_inbox_unread_count(session_id) > 0:
                logger.debug(
                    "thinking trigger deferred — inbox has unread for %s",
                    session_id,
                )
                await self._kick_inbox_drain(session_id)
                return

            picked = self._pick_category_and_prompt(session_id, is_executing)
            if picked is None:
                return
            prompt, chosen_category = picked

            # When the preset's screen-observation category fired (a category
            # with requires_screen_active), attach the live screen frame so the
            # persona reacts to what's literally on screen. The prompt text comes
            # from the editable preset — no hardcoded copy here. If a frame can't
            # be grabbed this instant, skip the fire: the category demands a real
            # frame, and the next tick retries (or the category stops being
            # eligible once the share ends).
            screen_attachment = None
            if getattr(chosen_category, "requires_screen_active", False):
                from service.vtuber.screen_observation import (
                    screen_changed_since_last_comment,
                    mark_screen_comment,
                )
                # De-dup: don't narrate an unchanged screen again. Robust to the
                # captured avatar overlay (lenient hash threshold).
                if not screen_changed_since_last_comment(session_id):
                    logger.info(
                        "[ThinkingTrigger] screen unchanged since last comment — "
                        "skipping for %s", session_id,
                    )
                    return
                try:
                    from service.vtuber.screen_observation import (
                        capture_current_screen_attachment,
                        get_recent_frame_attachment,
                    )
                    # Prefer a fresh WS live-grab; fall back to the most recent
                    # UPLOADED frame (always arriving via HTTP) so this works
                    # even when the connector doesn't implement the live-grab
                    # capability.
                    screen_attachment = await capture_current_screen_attachment(session_id)
                    if screen_attachment is None:
                        screen_attachment = get_recent_frame_attachment(session_id)
                except Exception:  # noqa: BLE001
                    logger.debug("thinking trigger: screen capture failed", exc_info=True)
                    screen_attachment = None
                if screen_attachment is None:
                    logger.info(
                        "[ThinkingTrigger] screen category chosen but no frame "
                        "(WS grab + upload cache both empty) — skipping for %s",
                        session_id,
                    )
                    return
                # Mark this screen as commented BEFORE firing — even a [SILENT]
                # response means "nothing new to say about THIS screen", so the
                # same frame shouldn't re-trigger.
                mark_screen_comment(session_id)

            import re
            _tag_match = re.search(r'\[(THINKING|ACTIVITY)_TRIGGER(?::\w+)?\]', prompt)
            _tag_end = _tag_match.end() if _tag_match else 20
            prompt_preview = prompt[_tag_end:_tag_end + 50].strip().replace("\n", " ")

            is_activity = prompt.startswith("[ACTIVITY_TRIGGER")
            trigger_timeout = 600.0 if is_activity else 180.0
            source_metadata = self._build_reflection_metadata(prompt)

            exec_kwargs: dict = {
                "is_trigger": True,
                "timeout": trigger_timeout,
                "source_metadata": source_metadata,
            }
            if screen_attachment is not None:
                exec_kwargs["attachments"] = [screen_attachment]

            result = await execute_command(session_id, prompt, **exec_kwargs)

            self._consecutive_triggers[session_id] = (
                self._consecutive_triggers.get(session_id, 0) + 1
            )

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

    # ── Prompt selection (two-stage roulette) ───────────────

    def _build_trigger_prompt(
        self, session_id: str, is_executing_fn
    ) -> Optional[str]:
        """Back-compat wrapper: return only the rendered prompt string.

        New code wanting to know which category fired (e.g. to attach a screen
        frame for a ``requires_screen_active`` category) should call
        :meth:`_pick_category_and_prompt` instead."""
        picked = self._pick_category_and_prompt(session_id, is_executing_fn)
        return picked[0] if picked else None

    @staticmethod
    def _screen_active_for(session_id: str) -> bool:
        """True only when the user is actively sharing their screen AND the
        session's model can actually see images — so a ``requires_screen_active``
        category never fires a screen prompt the persona can't ground in a
        real frame."""
        try:
            from service.vtuber.screen_observation import (
                is_screen_active,
                _session_vision_capable,
            )
            return bool(is_screen_active(session_id) and _session_vision_capable(session_id))
        except Exception:  # noqa: BLE001
            return False

    def _pick_category_and_prompt(
        self, session_id: str, is_executing_fn
    ) -> Optional[Tuple[str, TriggerCategory]]:
        """Pick a category, then a prompt within it, then render.

        Resolution path:

        1. Pull the active manifest (preset or default fallback).
        2. Snapshot session state (consec, sub-worker, time window,
           screen-active).
        3. Filter the manifest's categories — keep those whose
           conditions hold under the current snapshot and whose
           per-category cooldown has elapsed.
        4. Stage-1 roulette: pick one category by ``Category.weight``.
        5. Stage-2 roulette: pick one prompt by per-prompt weight in
           the chosen category.
        6. Render via :func:`schemas.render_prompt` to the canonical
           ``[KIND_TRIGGER:id] [autonomous_signal: …] {content}`` form.

        Returns ``(rendered_prompt, chosen_category)``, or ``None`` when the
        manifest is disabled or no category passes the filter.
        """
        manifest = self._resolve_manifest(session_id)
        if not manifest.enabled:
            return None

        locale = self._get_locale()
        count = self._consecutive_triggers.get(session_id, 0)

        linked_id, sub_worker_busy = self._probe_sub_worker_state(
            session_id, is_executing_fn
        )
        time_window = _resolve_time_window(manifest, self._current_hour())
        screen_active = self._screen_active_for(session_id)
        now = time.time()
        last_fires = self._last_category_fire.setdefault(session_id, {})

        # Build a prompt-id index once for stage-2 lookups.
        prompt_index: Dict[str, TriggerPrompt] = {
            p.id: p for p in manifest.prompts
        }

        eligible: List[Tuple[float, TriggerCategory]] = []
        for cat in manifest.categories:
            if not _category_eligible(
                cat,
                consec=count,
                sub_worker_busy=sub_worker_busy,
                sub_worker_linked=linked_id is not None,
                time_window=time_window,
                last_fire_at=last_fires.get(cat.id, 0.0),
                now=now,
                screen_active=screen_active,
            ):
                continue
            if cat.weight <= 0:
                continue
            # Skip categories that reference nothing or whose every
            # prompt_ref points at a deleted prompt.
            usable_refs = [
                r
                for r in cat.prompt_refs
                if r.weight > 0 and r.prompt_id in prompt_index
            ]
            if not usable_refs:
                continue
            eligible.append((cat.weight, cat))

        chosen_category = _weighted_pick(eligible)
        if chosen_category is None:
            return None
        assert isinstance(chosen_category, TriggerCategory)

        # Stage 2: roulette across the chosen category's prompt_refs.
        ref_pool: List[Tuple[float, PromptRef]] = [
            (r.weight, r)
            for r in chosen_category.prompt_refs
            if r.weight > 0 and r.prompt_id in prompt_index
        ]
        if not ref_pool:
            # Degenerate fallback: any non-zero ref, uniform weight.
            ref_pool = [
                (1.0, r)
                for r in chosen_category.prompt_refs
                if r.prompt_id in prompt_index
            ]
        chosen_ref = _weighted_pick(ref_pool)
        if chosen_ref is None:
            return None
        assert isinstance(chosen_ref, PromptRef)

        prompt = prompt_index.get(chosen_ref.prompt_id)
        if prompt is None:
            return None

        content = (
            prompt.content.get(locale)
            or prompt.content.get("en")
            or next(iter(prompt.content.values()), "")
        )
        if not content.strip():
            return None

        # Mark cooldown so the next tick filters this category until the
        # window elapses.
        if chosen_category.cooldown_seconds and chosen_category.cooldown_seconds > 0:
            last_fires[chosen_category.id] = now

        return render_prompt(chosen_category, content), chosen_category

    @staticmethod
    def _probe_sub_worker_state(
        session_id: str, is_executing_fn
    ) -> Tuple[Optional[str], bool]:
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

    # ── Locale + clock helpers ──────────────────────────────

    @staticmethod
    def _get_locale() -> str:
        lang = os.environ.get("GENY_LANGUAGE", "en")
        return lang if lang in ("en", "ko") else "en"

    @staticmethod
    def _current_hour() -> int:
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
