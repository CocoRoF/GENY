"""
Screen observation — VTuber-initiated proactive screen-capture trigger.

When the user toggles "screen observation" ON in the VTuber tab, the
frontend periodically captures a frame of their screen and POSTs it to
``/api/vtuber/screen-observation/upload``. This module is the backend
landing site:

  1. **Persist** — image bytes drop into the *session's* storage path
     (``<storage_path>/observations/<ts>.png``). A small markdown
     sidecar (``<ts>.md``) carries the caption + frontmatter so the
     VTuber's agent can retrieve past observations via the regular
     memory tools.

  2. **Caption** — re-uses the same vision-LLM helper the whiteboard
     image hook relies on (``_try_vision_describe``). Caption-failure
     short-circuits the trigger (we never bother the persona without
     a real "what I saw" string).

  3. **Trigger** — fires a synthetic ``[USER_OBSERVATION]`` prompt
     through ``agent_executor.execute_command`` with ``is_trigger=True``.
     The persona may respond with ``[SILENT]`` to decline the
     conversation; the sanitiser strips that token and the existing
     empty-response guard in the trigger result handler skips the
     chat-insert (mirrors the ambient STT trigger path).

A per-session **cooldown** (default 10 min, env override) prevents
the persona from being asked to react to every 3-min capture. Every
capture still lands on disk + is captioned, but only some of them
fire a trigger; the rest silently accumulate as memory the persona
can browse if it wants context.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from logging import getLogger
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

logger = getLogger(__name__)


# ── Tunables ──────────────────────────────────────────────────────────


# ── Talkativeness levels ──────────────────────────────────────────────
# How proactively the persona reacts to the screen while observation is ON.
# Each level maps to (min_gap, change_threshold, max_silence):
#   * min_gap          — minimum seconds between two trigger fires (anti-burst).
#   * change_threshold — dHash Hamming distance below which two consecutive
#                        frames count as "unchanged" → vision + trigger skipped
#                        (cheap). Lower = more sensitive to small changes.
#   * max_silence      — even with no change, surface a comment if this long has
#                        passed since the last fire (ambient presence).
# The client sends its chosen level per upload; the server clamps min_gap to a
# hard floor so a buggy/hostile client can't spam the persona.
_LEVELS: Dict[str, Dict[str, float]] = {
    "chatty":   {"min_gap": 45.0,  "change_threshold": 4.0,  "max_silence": 300.0},
    "balanced": {"min_gap": 90.0,  "change_threshold": 8.0,  "max_silence": 600.0},
    "calm":     {"min_gap": 180.0, "change_threshold": 12.0, "max_silence": 1200.0},
}
_DEFAULT_LEVEL = "chatty"


def _min_gap_floor() -> float:
    """Hard server-side lower bound on the inter-trigger gap, regardless of the
    client-requested level. Anti-spam guard. Default 20s."""
    try:
        return float(os.environ.get("GENY_SCREEN_OBS_MIN_GAP_FLOOR_S", "20"))
    except ValueError:
        return 20.0


def _level_params(level: Optional[str]) -> Dict[str, float]:
    """Resolve a talkativeness level name → its behavior params, with the
    min_gap clamped to the server floor. A legacy explicit
    ``GENY_SCREEN_OBSERVATION_COOLDOWN_S`` still overrides min_gap when set
    (back-compat escape hatch for anyone who pinned a fixed cooldown)."""
    p = dict(_LEVELS.get((level or _DEFAULT_LEVEL).strip().lower(), _LEVELS[_DEFAULT_LEVEL]))
    legacy = os.environ.get("GENY_SCREEN_OBSERVATION_COOLDOWN_S")
    if legacy is not None:
        try:
            p["min_gap"] = float(legacy)
        except ValueError:
            pass
    p["min_gap"] = max(p["min_gap"], _min_gap_floor())
    return p


def _hamming(a: str, b: str) -> Optional[int]:
    """Bit-difference between two hex-encoded perceptual hashes, or ``None``
    when either side isn't valid hex (→ caller treats as 'changed')."""
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (ValueError, TypeError):
        return None


def _send_image_enabled() -> bool:
    """Whether the persona receives the REAL captured frame (multimodal)
    on the ``[USER_OBSERVATION]`` trigger, not just the text caption.
    Default ON. Set ``GENY_SCREEN_OBS_SEND_IMAGE=0`` to fall back to
    caption-only (cheaper, or for caption_only privacy mode)."""
    return os.environ.get(
        "GENY_SCREEN_OBS_SEND_IMAGE", "true"
    ).strip().lower() not in ("0", "false", "no", "off")


def _retention_days() -> int:
    """How long observation IMAGE files are kept on disk before
    best-effort pruning. The markdown notes (caption text) are kept
    regardless so the persona can still recall what it saw. Default 7
    days. ``0`` disables pruning."""
    try:
        return int(os.environ.get("GENY_SCREEN_OBS_RETENTION_DAYS", "7"))
    except ValueError:
        return 7


# Mime → file extension. Browser MediaRecorder + canvas.toBlob
# defaults to PNG; we accept JPEG as well for clients that prefer
# size over fidelity. Anything else falls back to ``.bin`` and gets
# rejected by the vision LLM downstream.
_MIME_TO_EXT: Dict[str, str] = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
}


# ── Cooldown state ────────────────────────────────────────────────────


_last_fire_at: Dict[str, float] = {}
# Per-session last recorded caption — skips writing a near-identical
# observation note when the screen hasn't meaningfully changed (the
# vision LLM returns the same caption), so the vault doesn't fill with
# hundreds of "User is editing Python" duplicates.
_last_caption: Dict[str, str] = {}
# Per-session last perceptual hash (dHash hex from the client). Lets the backend
# skip the vision call + trigger entirely when the screen hasn't meaningfully
# changed since the previous frame — the main cost lever that makes a faster
# capture cadence affordable.
_last_hash: Dict[str, str] = {}
# Per-storage-root throttle for the retention sweep — the rglob is cheap on a
# pruned tree but pointless to run on every ~3-min upload.
_last_prune_at: Dict[str, float] = {}
# Per-session "screen observation toggle is ON" marker, refreshed on every
# upload. Lets the backend decide whether a conversation turn may grab a fresh
# screen frame from the connector — gated on the user's toggle, never captures
# silently when observation is off.
_screen_active_until: Dict[str, float] = {}
# Per-session latest uploaded frame: (image_bytes, mime_type, monotonic_ts).
# The HTTP upload is the frame source that ALWAYS arrives (vs the WS live-grab
# capability, which the connector may not implement). The thinking-trigger's
# screen category attaches this to the persona's own vision model, so screen
# commentary works even when the caption LLM is unavailable and the WS grab
# isn't supported.
_latest_frame: Dict[str, Tuple[bytes, str, float]] = {}
_lock = asyncio.Lock()


def _screen_active_window() -> float:
    """How long after the last upload a session counts as 'observing'. A bit
    over 2× the 3-min capture interval so a missed tick doesn't flap it off."""
    try:
        return float(os.environ.get("GENY_SCREEN_OBS_ACTIVE_WINDOW_S", "400"))
    except ValueError:
        return 400.0


def _mark_screen_active(session_id: str) -> None:
    _screen_active_until[session_id] = time.monotonic() + _screen_active_window()


def is_screen_active(session_id: str) -> bool:
    """True when screen observation is currently ON for the session (a frame
    was uploaded within the active window)."""
    return time.monotonic() < _screen_active_until.get(session_id, 0.0)


def list_active_sessions() -> list:
    """Session ids currently sharing their screen (a frame within the active
    window). The thinking-trigger unions these into its scan so screen-active
    sessions keep getting commentary even if they weren't registered via a
    normal turn (e.g. lazily rehydrated after a restart)."""
    now = time.monotonic()
    return [sid for sid, exp in list(_screen_active_until.items()) if now < exp]


def get_recent_frame_attachment(session_id: str) -> Optional[Dict[str, Any]]:
    """Return the most-recently UPLOADED frame as a chat attachment (raw b64),
    or ``None``. Reliable fallback to the WS live-grab: the HTTP upload always
    arrives. Gated on the kill-switch, freshness (active window), and the
    session model being vision-capable — never hands a non-vision model an
    image it would choke on."""
    if not _send_image_enabled():
        return None
    if not is_screen_active(session_id):
        return None
    cached = _latest_frame.get(session_id)
    if not cached:
        return None
    data, mime, ts = cached
    if time.monotonic() - ts > _screen_active_window():
        return None
    if not _session_vision_capable(session_id):
        return None
    try:
        return {
            "kind": "image",
            "mime_type": mime or "image/jpeg",
            "data": base64.b64encode(data).decode("ascii"),
            "name": "screen.jpg",
            "source": "screen_observation",
        }
    except Exception:  # noqa: BLE001
        return None


async def _claim_trigger_slot(session_id: str, min_gap: float) -> bool:
    """Return True iff at least *min_gap* seconds have elapsed since the
    last successful trigger fire for *session_id*. On True, the slot
    is reserved immediately so a racing concurrent call doesn't
    double-fire."""
    async with _lock:
        last = _last_fire_at.get(session_id, 0.0)
        now = time.monotonic()
        if now - last < min_gap:
            return False
        _last_fire_at[session_id] = now
        return True


async def _release_trigger_slot(session_id: str) -> None:
    """Roll back a claimed slot if the trigger itself failed before
    actually running (so the next capture can try)."""
    async with _lock:
        _last_fire_at.pop(session_id, None)


def reset_cooldown_state_for_tests() -> None:
    """Test hook — clear the per-session cooldown + dedup + hash + prune + active tables."""
    _last_fire_at.clear()
    _last_caption.clear()
    _last_hash.clear()
    _last_prune_at.clear()
    _screen_active_until.clear()
    _latest_frame.clear()


def cleanup_session_state(session_id: str) -> None:
    """Drop a session's per-session screen-observation state (cooldown +
    dedup + last hash). Wire into session teardown so the in-memory tables
    don't grow unbounded across the process lifetime."""
    _last_fire_at.pop(session_id, None)
    _last_caption.pop(session_id, None)
    _last_hash.pop(session_id, None)
    _screen_active_until.pop(session_id, None)
    _latest_frame.pop(session_id, None)


# ── Sensitive-content redaction ───────────────────────────────────────

# The vision captioner is asked for on-screen text "verbatim" (so the
# persona can read code/errors), which means a password / API key / token
# visible on screen would otherwise be transcribed into a caption that is
# (a) sent to the persona and (b) persisted in a searchable memory note.
# Mask the obvious secret shapes BEFORE the caption is stored or sent.
# Conservative patterns — aimed at high-confidence secret shapes so normal
# prose isn't mangled.
_REDACT_PATTERNS = [
    re.compile(
        r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|"
        r"token|authorization|auth|bearer)\b\s*[:=]\s*\S+"
    ),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),            # OpenAI-style keys
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                  # AWS access key id
    re.compile(r"\bghp_[A-Za-z0-9]{30,}\b"),              # GitHub PAT
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"),  # JWT
    re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}\b"),          # long base64-ish blob
]


def _redact_sensitive(text: str) -> str:
    """Mask high-confidence secret shapes in *text*. Best-effort — returns
    the input unchanged on any error."""
    if not text:
        return text
    try:
        out = text
        for pat in _REDACT_PATTERNS:
            out = pat.sub("[REDACTED]", out)
        return out
    except Exception:  # noqa: BLE001
        return text


# ── Result types ──────────────────────────────────────────────────────


@dataclass(slots=True)
class ObservationResult:
    """Outcome of one observation upload."""

    observation_id: str
    session_id: str
    image_path: Optional[str] = None  # absolute path on disk
    note_path: Optional[str] = None   # absolute path on disk
    caption: str = ""
    vision_source: str = "not_attempted"  # "vision" | "placeholder" | "unavailable" | "skipped"
    trigger_fired: bool = False
    skipped_reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "observation_id": self.observation_id,
            "session_id": self.session_id,
            "image_path": self.image_path,
            "note_path": self.note_path,
            "caption": self.caption,
            "vision_source": self.vision_source,
            "trigger_fired": self.trigger_fired,
            "skipped_reason": self.skipped_reason,
        }


# ── Persistence ───────────────────────────────────────────────────────


async def _ensure_session_live(session_id: str) -> None:
    """Lazily wake a dormant (non-deleted) session so an actively-observing
    connector keeps the persona alive across backend restarts — otherwise every
    uploaded frame 404s (session not in memory) until the user manually
    re-opens the session, and the thinking-trigger never re-registers it.
    Best-effort + safe: ``ensure_session_live`` returns None (no-op) for
    unknown/deleted sessions, so this never resurrects a deleted one."""
    try:
        from service.executor import get_agent_session_manager
        await get_agent_session_manager().ensure_session_live(session_id)
    except Exception:  # noqa: BLE001
        logger.debug("screen_observation: ensure_session_live failed", exc_info=True)


def _resolve_session_storage(session_id: str) -> Optional[Path]:
    """Return the absolute ``<storage_path>`` for the live agent
    session, or ``None`` when the session isn't running.

    The agent owns the directory layout; we only mirror "screen
    observations" into a sibling subdir so the agent's other memory
    files / chat history aren't disturbed.
    """
    try:
        from service.executor import get_agent_session_manager
    except Exception:  # noqa: BLE001
        logger.debug("agent_session_manager unavailable", exc_info=True)
        return None
    agent = get_agent_session_manager().get_agent(session_id)
    if agent is None:
        return None
    storage = getattr(agent, "storage_path", None)
    if not storage:
        return None
    return Path(storage)


def _resolve_agent(session_id: str) -> Optional[Any]:
    """Best-effort live ``AgentSession`` lookup (or ``None``). Used for
    the session's model name (vision gating) and its memory manager
    (recall-able note recording)."""
    try:
        from service.executor import get_agent_session_manager
    except Exception:  # noqa: BLE001
        return None
    try:
        return get_agent_session_manager().get_agent(session_id)
    except Exception:  # noqa: BLE001
        return None


def _ext_to_mime(path: Path) -> str:
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
    }.get(path.suffix.lower().lstrip("."), "image/png")


def _session_vision_capable(session_id: str) -> bool:
    """Whether the session's model can take images.

    Screen observation is explicitly user-opted-in and Geny's default persona
    model is Claude (vision-capable), so this defaults OPTIMISTIC: an unknown /
    empty / bare-alias ("sonnet"/"opus"/"haiku") model is treated as vision-
    capable. The conservative ``is_vision_capable`` returns False for those,
    which silently disabled the whole screen feature on manifests that don't pin
    a full ``claude-*`` model id. Only a model that is recognised AND non-vision
    is rejected. Override with ``GENY_SCREEN_OBS_ASSUME_VISION=0/1``."""
    override = os.environ.get("GENY_SCREEN_OBS_ASSUME_VISION", "").strip().lower()
    if override in ("1", "true", "yes", "on"):
        return True
    if override in ("0", "false", "no", "off"):
        return False
    try:
        from service.whiteboard.vision_capability import is_vision_capable
    except Exception:  # noqa: BLE001
        return True  # can't check → assume capable (feature is opt-in)
    agent = _resolve_agent(session_id)
    model = getattr(agent, "model_name", None) if agent is not None else None
    if not model:
        model = (
            os.environ.get("ANTHROPIC_MODEL")
            or os.environ.get("GENY_DEFAULT_MODEL")
            or ""
        )
    if not model:
        return True  # unknown model → assume the default (Claude) can see
    if is_vision_capable(model):
        return True
    # Bare provider aliases the pattern list misses — all map to vision-capable
    # Claude models in Geny (see the pricing-alias layer).
    if model.strip().lower() in ("sonnet", "opus", "haiku", "claude"):
        return True
    return False


def _maybe_image_attachment(
    session_id: str, image_path: Path,
) -> Optional[list]:
    """Build the multimodal attachment that hands the persona the REAL
    captured frame — but only when the session's model supports vision
    and image-sending is enabled. Returns ``None`` (caption-only
    fallback) otherwise, so a non-vision model never gets an image it
    would choke on.

    Shape mirrors the chat-broadcast attachment the executor's
    ``MultimodalNormalizer`` already consumes: a ``file://`` URI that the
    normalizer inlines as a base64 image block (keeping huge base64 out
    of this module + out of the chat-history JSON)."""
    if not _send_image_enabled():
        return None
    if not _session_vision_capable(session_id):
        logger.info("[USER_OBSERVATION] model not vision-capable — caption-only")
        return None
    try:
        return [{
            "kind": "image",
            "mime_type": _ext_to_mime(image_path),
            "url": Path(image_path).as_uri(),
        }]
    except Exception:  # noqa: BLE001
        logger.debug("[USER_OBSERVATION] attachment build failed", exc_info=True)
        return None


async def capture_current_screen_attachment(
    session_id: str,
) -> Optional[Dict[str, Any]]:
    """Real-time per-turn capture (P3b): grab the CURRENT screen from the
    session's connector and return a chat attachment so the persona judges
    what's literally on screen right now. Returns ``None`` (turn proceeds
    without an image) unless ALL gates pass — never captures silently:

      * the screen-image kill-switch is on (``GENY_SCREEN_OBS_SEND_IMAGE``),
      * the session model is vision-capable,
      * screen observation is currently ON (a frame was uploaded recently —
        the connector reuses that already-open live stream, so this is fast),
      * a connector is registered and advertises ``screen_capture``.

    Fully guarded: any transport/timeout/parse error → ``None``."""
    if not _send_image_enabled():
        return None
    if not is_screen_active(session_id):
        return None
    if not _session_vision_capable(session_id):
        return None
    try:
        from service.executor.connector_registry import get_connector_registry
    except Exception:  # noqa: BLE001
        return None
    conn = get_connector_registry().get(session_id)
    if conn is None or "screen_capture" not in getattr(conn, "accepted_capabilities", set()):
        return None
    try:
        payload = await conn.capability_call(
            # live_only: the connector must capture from the already-open
            # observation stream and refuse if it's gone — so a turn never
            # grabs the screen after the user toggled observation off.
            # Short timeout: the live-stream grab is ~instant; this only bites
            # if the connector is hung, and it's fully additive to the turn's
            # time-to-first-token, so fail fast rather than stall the reply.
            "screen_capture", {"live_only": True}, "live turn vision", timeout=2.5,
        )
    except Exception:  # noqa: BLE001
        logger.debug("[turn-vision] connector capture failed", exc_info=True)
        return None
    if not isinstance(payload, dict) or not payload.get("ok"):
        return None
    result = payload.get("result") or {}
    b64 = result.get("image_b64")
    if not b64:
        return None
    # Tolerate a data: URL prefix → RAW base64 for the executor normalizer.
    raw = b64.split(",", 1)[-1]
    mime = result.get("mime", "image/jpeg")
    return {
        "kind": "image",
        "mime_type": mime,
        "data": raw,
        "name": "screen.jpg",
        "source": "screen_observation",
    }


def _build_observation_paths(
    storage_root: Path, observation_id: str, mime_type: Optional[str],
) -> Tuple[Path, Path]:
    """Compute ``(image_path, note_path)`` under
    ``<storage>/memory/observations/<YYYY-MM-DD>/``.

    The image lives **inside the memory vault** (``memory/observations/``)
    — not a sibling dir — so (a) the ``![[image]]`` wikilink resolves in
    an Obsidian client, (b) retention can find + prune old frames, and
    (c) the recall-able note (written flat under the ``observations``
    category by the memory provider) sits in the same tree. Date-bucketing
    keeps a long-running session from piling thousands of images into one
    directory. The ``note_path`` here is only the *fallback* sidecar used
    when the live memory manager is unavailable; the normal path writes
    the note through the provider so it is indexed + searchable."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    bucket = storage_root / "memory" / "observations" / today
    bucket.mkdir(parents=True, exist_ok=True)
    ext = _MIME_TO_EXT.get((mime_type or "").lower(), "png")
    return bucket / f"{observation_id}.{ext}", bucket / f"{observation_id}.md"


def _write_observation_note(
    *,
    note_path: Path,
    image_path: Path,
    caption: str,
    vision_source: str,
    captured_at: datetime,
) -> None:
    """Drop a small markdown sidecar next to the image. Frontmatter
    matches the user-opsidian frontmatter style closely enough that
    a future "list past observations" tool can ``read_text`` +
    ``yaml.safe_load`` without surprises."""
    fm = {
        "title": f"Screen observation {captured_at.strftime('%Y-%m-%d %H:%M:%S')}",
        "category": "observations",
        "captured_at": captured_at.isoformat(),
        "vision_source": vision_source,
        "image": image_path.name,
    }
    fm_lines = ["---"]
    for k, v in fm.items():
        fm_lines.append(f'{k}: "{v}"')
    fm_lines.append("---")
    body = (
        "\n".join(fm_lines)
        + "\n\n"
        + f"![[{image_path.name}]]\n\n"
        + (f"> **Auto-caption:** {caption.strip()}\n" if caption else "_(no caption)_\n")
    )
    note_path.write_text(body, encoding="utf-8")


async def _record_observation_note(
    *,
    session_id: str,
    image_path: Path,
    note_path: Path,
    caption: str,
    vision_source: str,
    captured_at: datetime,
    observation_id: str,
    force: bool = False,
) -> Optional[str]:
    """Record the observation into the session's **recall-able** memory
    vault so the persona can later answer "what was on my screen
    earlier?" via its normal ``memory_search`` / ``memory_list`` tools.

    Path of record: ``agent.memory_manager.awrite_note`` →
    ``memory/observations/<file>.md`` (provider-indexed). Falls back to a
    raw sidecar next to the image when the live memory manager isn't
    available (e.g. during tests or before the agent finishes init), so
    the observation is never lost.

    Caption-dedup: an identical consecutive caption for the same session
    is skipped (returns ``None``) unless *force* — keeps the vault from
    filling with duplicate "User is editing Python" notes when the screen
    sits still. ``force`` (the "Show Now" button) always records."""
    cap = (caption or "").strip()
    if not force and cap and _last_caption.get(session_id) == cap:
        logger.debug(
            "[USER_OBSERVATION] duplicate caption for %s — skipping note",
            session_id,
        )
        return None

    body = (
        f"![[{image_path.name}]]\n\n"
        + (
            f"> **Auto-caption:** {cap}\n\n" if cap
            else "_(no caption)_\n\n"
        )
        + f"- captured_at: {captured_at.isoformat()}\n"
        + f"- vision_source: {vision_source}\n"
        + f"- observation_id: {observation_id}\n"
    )

    ref: Optional[str] = None
    agent = _resolve_agent(session_id)
    mm = getattr(agent, "memory_manager", None) if agent is not None else None
    if mm is not None:
        # Live memory manager present → record into the recall-able vault.
        # We TRUST it (success → ref; failure → None) and never also write a
        # raw sidecar, so the observation isn't written twice.
        try:
            stamp = captured_at.strftime("%Y%m%d-%H%M%S")
            ref = await mm.awrite_note(
                title=(
                    "Screen observation "
                    f"{captured_at.strftime('%Y-%m-%d %H:%M:%S')}"
                ),
                content=body,
                category="observations",
                tags=["screen", "observation"],
                importance="low",
                source="screen_observation",
                filename_override=f"{stamp}-{observation_id}.md",
            )
            if not ref:
                logger.debug(
                    "[USER_OBSERVATION] awrite_note returned None "
                    "(no provider) — observation kept via manager's legacy path",
                )
        except Exception:  # noqa: BLE001
            logger.warning(
                "[USER_OBSERVATION] vault note write failed", exc_info=True,
            )
            ref = None
    else:
        # No live manager (tests, or agent still initialising) → raw sidecar
        # so the observation is never lost. Degraded: not provider-indexed.
        try:
            _write_observation_note(
                note_path=note_path,
                image_path=image_path,
                caption=caption,
                vision_source=vision_source,
                captured_at=captured_at,
            )
            ref = str(note_path)
        except OSError:
            logger.warning(
                "screen_observation: fallback note write failed", exc_info=True,
            )
            ref = None

    # Mark the caption as "seen" for dedup ONLY after a successful write, so a
    # transient write failure doesn't permanently drop the next identical
    # capture.
    if ref and cap:
        _last_caption[session_id] = cap
    return ref


def _prune_old_observations(storage_root: Path) -> None:
    """Best-effort: delete observation IMAGE files older than the
    retention window so disk doesn't grow unbounded. The markdown notes
    (caption text) are kept regardless — they're tiny and carry the
    recall value. Fully guarded; any failure is swallowed."""
    days = _retention_days()
    if days <= 0:
        return
    # Throttle: at most once an hour per storage root (the sweep walks the
    # whole observations tree; running it every 3-min upload is wasteful).
    key = str(storage_root)
    now = time.monotonic()
    if now - _last_prune_at.get(key, 0.0) < 3600:
        return
    _last_prune_at[key] = now
    try:
        root = storage_root / "memory" / "observations"
        if not root.exists():
            return
        cutoff = time.time() - days * 86400
        for img in root.rglob("*"):
            try:
                if not img.is_file():
                    continue
                if img.suffix.lower() in (".md",):
                    continue
                if img.stat().st_mtime < cutoff:
                    img.unlink()
            except OSError:
                continue
    except Exception:  # noqa: BLE001
        logger.debug("screen_observation: prune skipped", exc_info=True)


# ── Vision LLM caption ───────────────────────────────────────────────

# Screen-tailored caption prompt (distinct from the whiteboard default). Pulls
# out the active app/window, the user's current activity, key on-screen text,
# and a concrete hook the persona can react to — so the proactive comment is
# specific ("막혔어 보이는 그 import 에러?") not generic ("도와줄까?").
_SCREEN_CAPTION_INSTRUCTION = (
    "This is a screenshot of the user's screen, glanced at by an avatar sitting "
    "beside them. In 1–2 concrete sentences: which app/window is in focus, what "
    "the user is doing right now, the most important visible text (verbatim, only "
    "what matters), and one specific thing worth reacting to — progress, an error, "
    "something they seem stuck on, or a notable change. If the screen is essentially "
    "empty (bare desktop, lock screen), say so plainly."
)


async def _caption_image(
    image_bytes: bytes, *, mime_type: str,
) -> Tuple[str, str]:
    """Return ``(caption, vision_source)``.

    ``vision_source`` is one of:
      * ``"vision"``      → real caption from the vision LLM
      * ``"placeholder"`` → vision unavailable, caption is generic
      * ``"unavailable"`` → caption helper itself failed
    """
    try:
        from tools.custom.whiteboard_tools import _try_vision_describe
    except Exception:  # noqa: BLE001
        return ("", "unavailable")
    try:
        caption = await _try_vision_describe(
            image_bytes, content_type=mime_type, instruction=_SCREEN_CAPTION_INSTRUCTION,
        )
    except Exception:  # noqa: BLE001
        logger.warning("screen_observation: vision describe failed", exc_info=True)
        return ("", "unavailable")
    if caption:
        return (caption, "vision")
    return ("", "placeholder")


# ── Public entry point ───────────────────────────────────────────────


async def save_and_maybe_trigger(
    *,
    session_id: str,
    image_bytes: bytes,
    mime_type: str = "image/png",
    force_trigger: bool = False,
    frame_hash: Optional[str] = None,
    talkativeness: Optional[str] = None,
) -> ObservationResult:
    """Persist the image + caption into the session's storage and,
    when the change-gate + min-gap allow, fire the synthetic
    ``[USER_OBSERVATION]`` trigger.

    *frame_hash* is the client's perceptual hash (dHash hex) of this frame.
    When it's within the level's threshold of the previous frame the screen
    counts as unchanged → the expensive vision caption AND the trigger are
    skipped (cheap path), unless the ambient ``max_silence`` window has
    elapsed. Absent hash → treated as changed (back-compat with old clients).

    *talkativeness* picks the cadence/sensitivity level ("chatty" | "balanced"
    | "calm"); defaults to the chatty profile.

    *force_trigger* bypasses BOTH the change-gate and the min-gap — wired to
    the "Show Now" manual button so a deliberate user click is never swallowed.
    """
    observation_id = uuid.uuid4().hex[:12]
    captured_at = datetime.now(timezone.utc)
    params = _level_params(talkativeness)
    # Every upload refreshes the "observing" marker so conversation turns may
    # grab a fresh frame from the connector (P3b) only while the toggle is ON.
    _mark_screen_active(session_id)
    # Wake a dormant session (e.g. after a backend restart) so observation keeps
    # working without a manual re-open. No-op when already live or deleted.
    await _ensure_session_live(session_id)
    result = ObservationResult(
        observation_id=observation_id, session_id=session_id,
    )

    storage_root = _resolve_session_storage(session_id)
    if storage_root is None:
        result.skipped_reason = "session_not_found"
        return result

    if not image_bytes:
        result.skipped_reason = "empty_image"
        return result

    # Cache the latest frame for the thinking-trigger's screen category (which
    # attaches it straight to the persona's vision model). Done before the
    # change-gate so even an "unchanged" frame keeps the cache fresh.
    _latest_frame[session_id] = (image_bytes, mime_type, time.monotonic())

    # ── Change-gate ──────────────────────────────────────────────────
    # Skip the vision call + trigger when the frame is ~identical to the last
    # one (the dedup already drops duplicate memory notes, so we lose nothing).
    # This is what makes a faster capture cadence affordable. A forced capture
    # or a long ambient silence overrides the gate so the persona isn't mute
    # while the user stares at a static screen.
    changed = True
    if frame_hash:
        prev = _last_hash.get(session_id)
        if prev is not None:
            dist = _hamming(prev, frame_hash)
            if dist is not None:
                changed = dist >= params["change_threshold"]
        _last_hash[session_id] = frame_hash
    if not changed and not force_trigger:
        since_fire = time.monotonic() - _last_fire_at.get(session_id, 0.0)
        if since_fire >= params["max_silence"]:
            changed = True  # ambient: surface something despite no change
    if not changed and not force_trigger:
        result.skipped_reason = "unchanged"
        return result

    image_path, note_path = _build_observation_paths(
        storage_root, observation_id, mime_type,
    )

    try:
        image_path.write_bytes(image_bytes)
    except OSError as exc:
        logger.warning("screen_observation: image write failed (%s)", exc)
        result.skipped_reason = f"image_write_failed: {exc}"
        return result
    result.image_path = str(image_path)

    caption, vision_source = await _caption_image(
        image_bytes, mime_type=mime_type,
    )
    # Mask secrets the captioner may have transcribed verbatim BEFORE the
    # caption is stored in a searchable note or sent to the persona.
    caption = _redact_sensitive(caption)
    result.caption = caption
    result.vision_source = vision_source

    result.note_path = await _record_observation_note(
        session_id=session_id,
        image_path=image_path,
        note_path=note_path,
        caption=caption,
        vision_source=vision_source,
        captured_at=captured_at,
        observation_id=observation_id,
        force=force_trigger,
    )
    # Best-effort disk hygiene — old frames age out; notes (caption
    # text) stay for recall.
    _prune_old_observations(storage_root)

    # Trigger only when the vision LLM produced a real caption AND
    # the cooldown allows (or the caller forces). No-caption captures
    # still land on disk for future memory recall — they just don't
    # bother the persona.
    if vision_source != "vision" or not caption.strip():
        result.skipped_reason = (
            "no_real_caption" if vision_source != "vision" else "empty_caption"
        )
        # Diagnostic (only on a CHANGED frame — the gate already dropped static
        # ones, so this isn't per-tick noise): a persistent "no_real_caption"
        # means the vision captioner is unavailable/erroring, which would
        # otherwise silently keep the persona from reacting to the screen.
        logger.info(
            "[USER_OBSERVATION] no trigger for %s — %s (vision_source=%s, caption_len=%d)",
            session_id, result.skipped_reason, vision_source, len(caption or ""),
        )
        return result

    if not force_trigger:
        claimed = await _claim_trigger_slot(session_id, params["min_gap"])
        if not claimed:
            result.skipped_reason = "cooldown"
            return result
    else:
        async with _lock:
            _last_fire_at[session_id] = time.monotonic()

    try:
        await _run_trigger(
            session_id=session_id,
            observation_id=observation_id,
            caption=caption,
            captured_at=captured_at,
            image_path=image_path,
            talkativeness=(talkativeness or _DEFAULT_LEVEL),
        )
        result.trigger_fired = True
    except Exception:  # noqa: BLE001
        logger.warning(
            "screen_observation: trigger fire failed", exc_info=True,
        )
        result.skipped_reason = "trigger_error"
        # Release the slot so the next 3-min capture can try again
        # instead of waiting out the full cooldown after a bug.
        await _release_trigger_slot(session_id)
    return result


# ── Synthetic [USER_OBSERVATION] trigger ────────────────────────────


# Per-level reaction bias. Default (chatty) wants the persona to almost always
# say something specific about the screen; calm keeps it reserved. [SILENT] is
# always available for sensitive/empty screens — that guard never weakens.
_LEVEL_BIAS: Dict[str, str] = {
    "chatty": (
        "  • 기본적으로 *반응해라*. 방금 본 화면에서 구체적인 것 하나를 짚어 "
        "짧고 자연스럽게 한마디 해 — 진행 상황 칭찬, 눈에 띄는 변화, 막혀 보이는 "
        "지점, 가벼운 코멘트 등 뭐든 좋다. 한두 문장이면 충분.\n"
    ),
    "balanced": (
        "  • 화면에 반응할 거리가 있으면 (변화·에러·진행·흥미로운 것) 구체적으로 "
        "한마디 해. 정말 아무 일도 없으면 가볍게 넘어가도 된다.\n"
    ),
    "calm": (
        "  • 꼭 말할 가치가 있을 때만 (의미 있는 변화·에러·막힘) 짧게 반응해. "
        "그 외에는 조용히 있어도 된다.\n"
    ),
}


def _compose_prompt(
    *, caption: str, observation_id: str, captured_at: datetime,
    talkativeness: str = _DEFAULT_LEVEL,
) -> str:
    payload: Dict[str, Any] = {
        "observation_id": observation_id,
        "captured_at": captured_at.isoformat(),
        "caption": caption[:600],
        "share_source": "vtuber_screen_observation",
    }
    bias = _LEVEL_BIAS.get((talkativeness or _DEFAULT_LEVEL).strip().lower(), _LEVEL_BIAS[_DEFAULT_LEVEL])
    body = (
        "방금 사용자 화면을 옆에서 잠깐 살펴봤어 — 위 caption 이 너가 본 거야. "
        "다음 규칙을 지켜:\n"
        + bias
        + "  • 구체적으로 말해. \"혹시 그 [구체적인 부분] 막혔어?\" 처럼. "
        "영혼 없는 \"도와줄까?\" 류 일반론은 금지.\n"
        "  • \"공유해 주셨네요\" 류 표현 금지 — 너가 *옆에서 본 것* "
        "이지 사용자가 보낸 게 아니다.\n"
        "  • 캡션에 비밀번호 / 개인 메시지 / API 키 / 결제 정보 등 "
        "민감해 보이는 텍스트가 보이면 그 부분을 *입에 올리지 마라*. 그럴 땐 "
        "추상적으로 우회하거나, 정말 할 말이 없으면 출력 첫 줄에 **[SILENT]** "
        "토큰만 써라 (그러면 chat 에 아무것도 안 나간다). 빈 바탕화면 등 반응할 "
        "게 전혀 없을 때도 [SILENT]."
    )
    return (
        f"[USER_OBSERVATION] {json.dumps(payload, ensure_ascii=False)}\n"
        f"{body}"
    )


async def _run_trigger(
    *,
    session_id: str,
    observation_id: str,
    caption: str,
    captured_at: datetime,
    image_path: Path,
    talkativeness: str = _DEFAULT_LEVEL,
) -> None:
    """Hand the synthetic prompt to ``execute_command``, then mirror
    the response to the chat room (skipping ``[SILENT]`` / empty
    output — the sanitiser turns ``[SILENT]`` into empty string and
    the empty-guard below short-circuits)."""
    try:
        from service.execution.agent_executor import execute_command  # type: ignore
    except Exception:  # noqa: BLE001
        logger.debug("agent_executor unavailable", exc_info=True)
        return

    prompt = _compose_prompt(
        caption=caption,
        observation_id=observation_id,
        captured_at=captured_at,
        talkativeness=talkativeness,
    )

    # P1 — hand the persona the REAL captured frame (multimodal), not
    # just the text caption, when the session's model is vision-capable.
    # The caption stays in the prompt as a cheap "what I saw" anchor +
    # the sensitive-content guard; the image lets the persona reason over
    # pixels the caption can't fully convey (small text, layout, colours).
    attachments = _maybe_image_attachment(session_id, image_path)
    exec_kwargs: Dict[str, Any] = {"is_trigger": True, "timeout": 180}
    if attachments:
        exec_kwargs["attachments"] = attachments

    try:
        result = await execute_command(session_id, prompt, **exec_kwargs)
    except Exception:  # noqa: BLE001
        logger.warning(
            "[USER_OBSERVATION] execute_command failed", exc_info=True,
        )
        return

    logger.info(
        "[USER_OBSERVATION] fired for session %s (observation=%s, "
        "caption_len=%d)",
        session_id, observation_id, len(caption),
    )

    _save_trigger_response_to_chat(
        session_id=session_id,
        observation_id=observation_id,
        result=result,
    )


def _save_trigger_response_to_chat(
    *,
    session_id: str,
    observation_id: str,
    result: Any,
) -> None:
    """Mirror the persona's response into the chat room. Skip when:
      * the executor reported failure,
      * the sanitised text is empty (which is what ``[SILENT]``
        collapses to, since the system-tag sanitiser already covers
        the token).

    Best-effort: any failure here just logs and the user still sees
    the persona's reaction on the next normal turn (since the
    session memory has the observation note in it)."""
    try:
        if not getattr(result, "success", False):
            return
        output = getattr(result, "output", "") or ""

        try:
            from service.utils.text_sanitizer import sanitize_for_display
            cleaned = sanitize_for_display(output)
        except Exception:  # noqa: BLE001
            cleaned = output
        if not cleaned or not cleaned.strip():
            logger.info(
                "[USER_OBSERVATION] silent response for session %s "
                "(observation=%s) — not inserting into chat",
                session_id, observation_id,
            )
            return

        try:
            from service.executor import get_agent_session_manager
        except Exception:  # noqa: BLE001
            return
        agent = get_agent_session_manager().get_agent(session_id)
        if agent is None:
            return
        chat_room_id = getattr(agent, "_chat_room_id", None)
        if not chat_room_id:
            return

        try:
            from service.chat.conversation_store import get_chat_store
            store = get_chat_store()
        except Exception:  # noqa: BLE001
            return

        session_name = (
            getattr(agent, "_session_name", None) or session_id
        )
        role_val = getattr(agent, "_role", None)
        role = (
            role_val.value if hasattr(role_val, "value")
            else str(role_val or "vtuber")
        )

        msg = store.add_message(
            chat_room_id,
            {
                "type": "agent",
                "content": cleaned,
                "session_id": session_id,
                "session_name": session_name,
                "role": role,
                "duration_ms": getattr(result, "duration_ms", None),
                "cost_usd": getattr(result, "cost_usd", None),
                "source": "screen_observation_trigger",
                "metadata": {
                    "observation_id": observation_id,
                },
            },
        )
        logger.info(
            "[USER_OBSERVATION] response saved to chat room %s "
            "(msg_id=%s, len=%d)",
            chat_room_id, msg.get("id", "?"), len(cleaned),
        )
        try:
            from controller.chat_controller import _notify_room
            _notify_room(chat_room_id)
        except Exception:  # noqa: BLE001
            logger.debug(
                "[USER_OBSERVATION] notify_room failed for %s",
                chat_room_id, exc_info=True,
            )
    except Exception:  # noqa: BLE001
        logger.debug(
            "[USER_OBSERVATION] save_trigger_response_to_chat failed",
            exc_info=True,
        )
