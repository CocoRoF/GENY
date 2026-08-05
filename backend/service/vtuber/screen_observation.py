"""
Screen observation — landing site for the user's screen-share frames.

When the user toggles "screen observation" ON in the VTuber tab, the
frontend periodically captures a frame of their screen and POSTs it to
``/api/vtuber/screen-observation/upload``. This module (``save_observation``)
handles the upload:

  1. **Mark active + cache** — refresh the per-session "observing" marker,
     cache the latest frame (``get_recent_frame_attachment``), and record its
     perceptual hash (``screen_changed_since_last_comment``).

  2. **Persist (on change)** — when the frame meaningfully changed, the image
     drops into the session's storage (``<storage>/memory/observations/…``) and
     a recall-able memory note is written (caption via ``_try_vision_describe``,
     best-effort). Unchanged frames are skipped to avoid duplicate notes.

This module no longer fires its own proactive comment. Screen commentary is
owned by the SINGLE thinking-trigger ``screen_observation`` category (path B),
which consumes the cached frame + hash this module records. The "Show Now"
button forces an immediate comment via
``ThinkingTriggerService.fire_screen_now`` (called by the upload controller).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
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


def _hamming(a: str, b: str) -> Optional[int]:
    """Bit-difference between two hex-encoded perceptual hashes, or ``None``
    when either side isn't valid hex (→ caller treats as 'changed')."""
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (ValueError, TypeError):
        return None


def _same_screen_threshold() -> int:
    """dHash Hamming distance BELOW which the screen counts as "the same
    situation" for proactive-comment de-dup. Deliberately LENIENT (default
    10/64, vs the change-gate's ~4) so the captured avatar overlay's idle
    animation (a few flipped bits in its corner) never reads as a new
    situation — only a substantial screen change earns a fresh comment."""
    try:
        return int(os.environ.get("GENY_SCREEN_OBS_SAME_THRESHOLD", "10"))
    except ValueError:
        return 10


# Per-session dHash of the frame at the LAST proactive screen comment. Lets the
# thinking-trigger skip repeating itself when the screen hasn't meaningfully
# changed since it last spoke (robust to the avatar overlay being in-frame).
_last_comment_hash: Dict[str, str] = {}


def screen_changed_since_last_comment(session_id: str) -> bool:
    """True when the screen meaningfully changed since the last proactive screen
    comment for this session — so the persona doesn't keep narrating an
    unchanged screen. Returns True (allow) when there's no prior comment or no
    hash yet. Lenient threshold ignores the captured avatar's idle animation."""
    cur = _last_hash.get(session_id)
    if not cur:
        return True
    prev = _last_comment_hash.get(session_id)
    if not prev:
        return True
    dist = _hamming(prev, cur)
    if dist is None:
        return True
    return dist >= _same_screen_threshold()


def mark_screen_comment(session_id: str) -> None:
    """Record the current frame's hash as 'already commented on', so the next
    near-identical frame is de-duped. Called when a screen comment fires (even
    on [SILENT] — we don't want to re-ask about the same screen)."""
    cur = _last_hash.get(session_id)
    if cur:
        _last_comment_hash[session_id] = cur


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


# ── Per-session state ─────────────────────────────────────────────────


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


def reset_cooldown_state_for_tests() -> None:
    """Test hook — clear the per-session dedup + hash + prune + active tables."""
    _last_caption.clear()
    _last_hash.clear()
    _last_comment_hash.clear()
    _last_prune_at.clear()
    _screen_active_until.clear()
    _latest_frame.clear()


def cleanup_session_state(session_id: str) -> None:
    """Drop a session's per-session screen-observation state (dedup + last
    hash + comment hash). Wire into session teardown so the in-memory tables
    don't grow unbounded across the process lifetime."""
    _last_caption.pop(session_id, None)
    _last_hash.pop(session_id, None)
    _last_comment_hash.pop(session_id, None)
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


# Per-sweep cap on provider note deletions — bounds the first sweep on a
# vault with a large backlog (it catches up hourly) and keeps any single
# upload request from stalling behind thousands of index updates.
_PRUNE_NOTES_PER_SWEEP = 200


#: Live background prune sweeps. Two jobs, both load-bearing:
#:   1) hold a REFERENCE — asyncio only keeps a weak one, so a task with no
#:      strong reference can be garbage-collected mid-run;
#:   2) key by session, so an upload burst cannot start a sweep per frame.
#: Their absence was a NameError on EVERY observation upload (79 in 12h in
#: production) that aborted save_observation after the work was done.
_prune_tasks: Dict[str, "asyncio.Task"] = {}


async def _prune_old_observations(session_id: str, storage_root: Path) -> None:
    """Best-effort retention sweep over the AMBIENT observation buffer.

    ``memory/observations/`` is a rolling window, not an archive: frames
    the persona actually spoke about get promoted to
    ``memory/attachments/`` (``promote_used_frames``) and embedded in the
    execution/conversation record, so everything still here after the
    retention window is by definition unused — including frames the
    persona glanced at and stayed ``[SILENT]`` about. Past the window we
    delete BOTH the image files and the observation notes (via the
    provider, so index/graph stay consistent). Silent-tagged execution
    notes age out the same way. Fully guarded; any failure is swallowed.
    """
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
    cutoff = time.time() - days * 86400

    # 1) Image files (any non-.md in the observations tree).
    try:
        root = storage_root / "memory" / "observations"
        if root.exists():
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
        logger.debug("screen_observation: image prune skipped", exc_info=True)

    # 2) Notes — observation notes past the window, plus silent-turn
    #    execution notes. Provider-routed deletes keep the index/graph
    #    consistent; without a live manager we skip (never raw-unlink a
    #    provider-indexed note).
    agent = _resolve_agent(session_id)
    mm = getattr(agent, "memory_manager", None) if agent is not None else None
    if mm is None:
        return
    deleted = 0
    try:
        root = storage_root / "memory" / "observations"
        if root.exists():
            for md in sorted(root.glob("*.md")):
                if deleted >= _PRUNE_NOTES_PER_SWEEP:
                    break
                try:
                    if md.stat().st_mtime >= cutoff:
                        continue
                except OSError:
                    continue
                try:
                    if await mm.adelete_note(md.name):
                        deleted += 1
                except Exception:  # noqa: BLE001
                    logger.debug(
                        "observation note prune failed: %s", md.name,
                        exc_info=True,
                    )
    except Exception:  # noqa: BLE001
        logger.debug("screen_observation: note prune skipped", exc_info=True)

    # 3) Silent execution notes (tagged by record_execution) — same
    #    window, same cap budget.
    try:
        provider = getattr(agent, "memory_provider", None)
        if provider is not None and deleted < _PRUNE_NOTES_PER_SWEEP:
            summaries = await provider.index().list_notes(
                tag="silent", limit=_PRUNE_NOTES_PER_SWEEP, offset=0,
            )
            for summary in summaries or []:
                if deleted >= _PRUNE_NOTES_PER_SWEEP:
                    break
                modified = getattr(summary, "modified", "") or ""
                try:
                    stamp = datetime.fromisoformat(str(modified)).timestamp()
                except (ValueError, TypeError):
                    continue
                if stamp >= cutoff:
                    continue
                try:
                    if await mm.adelete_note(summary.filename):
                        deleted += 1
                except Exception:  # noqa: BLE001
                    logger.debug(
                        "silent note prune failed: %s",
                        getattr(summary, "filename", "?"),
                        exc_info=True,
                    )
    except Exception:  # noqa: BLE001
        logger.debug("screen_observation: silent prune skipped", exc_info=True)

    if deleted:
        logger.info(
            "[USER_OBSERVATION] retention sweep removed %d stale notes", deleted,
        )


# ── Frame promotion (used-in-conversation frames become permanent) ───

# Permanent bucket for frames the persona actually SPOKE about — either a
# user turn that carried a screen frame or a screen thinking-trigger that
# produced a non-[SILENT] reply. Lives OUTSIDE memory/observations/ so the
# retention sweep (which wipes the ambient buffer wholesale) never touches
# promoted frames; the execution/conversation note embeds them by name.
_PROMOTED_DIRNAME = "attachments"


def promote_used_frames(
    session_id: str,
    attachments: Optional[list],
    result_text: Optional[str],
) -> list:
    """Persist this turn's screen frame(s) permanently when the turn was
    actually spoken, returning the stored bare filenames for embedding
    into the execution/conversation record.

    Rules (one generalized gate for every caller):
      * only attachments marked ``source == "screen_observation"`` count;
      * a ``[SILENT]`` final output promotes nothing — an unspoken glance
        stays in the ambient observations buffer and ages out;
      * the file id is a content hash, so the same frame attached twice
        (e.g. retry) writes exactly one file.

    Fully guarded: any failure returns what was persisted so far.
    """
    from service.memory.note_utils import is_silent_reply

    frames = [
        a
        for a in (attachments or [])
        if isinstance(a, dict)
        and a.get("source") == "screen_observation"
        and a.get("data")
    ]
    if not frames or is_silent_reply(result_text):
        return []
    storage_root = _resolve_session_storage(session_id)
    if storage_root is None:
        return []

    names: list = []
    bucket = (
        storage_root
        / "memory"
        / _PROMOTED_DIRNAME
        / datetime.now(timezone.utc).strftime("%Y-%m-%d")
    )
    for att in frames:
        try:
            raw = base64.b64decode(att["data"])
            if not raw:
                continue
            ext = _MIME_TO_EXT.get(
                (att.get("mime_type") or "").lower(), "jpg",
            )
            digest = hashlib.sha1(raw).hexdigest()[:12]
            bucket.mkdir(parents=True, exist_ok=True)
            path = bucket / f"{digest}.{ext}"
            if not path.exists():
                path.write_bytes(raw)
            names.append(path.name)
        except Exception:  # noqa: BLE001
            logger.debug("promote_used_frames: frame skipped", exc_info=True)
    return names


# ── Vision LLM caption ───────────────────────────────────────────────

# Screen-tailored caption prompt (distinct from the whiteboard default). Pulls
# out the active app/window, the user's current activity, key on-screen text,
# and a concrete hook the persona can react to — so the recorded note is
# specific (e.g. "the import error they look stuck on") not generic.
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


async def save_observation(
    *,
    session_id: str,
    image_bytes: bytes,
    mime_type: str = "image/png",
    force: bool = False,
    frame_hash: Optional[str] = None,
) -> ObservationResult:
    """Land one screen-share frame: mark the session "observing", cache the
    latest frame, update the perceptual hash, and (when the screen changed)
    persist the image + a recall-able memory note.

    This function NO LONGER fires its own proactive comment. Screen commentary
    is owned by the single thinking-trigger ``screen_observation`` category
    (path B), which reuses the cached frame this function stores
    (``get_recent_frame_attachment``) and the hash it records
    (``screen_changed_since_last_comment``). The deliberate "Show Now" button
    forces an immediate comment via ``ThinkingTriggerService.fire_screen_now``,
    invoked by the upload controller — not here.

    *frame_hash* is the client's perceptual hash (dHash hex). When it is within
    the same-screen threshold of the previous frame, the (expensive) vision
    caption + memory note are skipped — nothing meaningful changed. *force*
    bypasses that skip so a deliberate capture is always persisted.
    """
    observation_id = uuid.uuid4().hex[:12]
    captured_at = datetime.now(timezone.utc)
    # Every upload refreshes the "observing" marker so conversation turns + the
    # thinking-trigger screen category know the toggle is ON.
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
    # attaches it straight to the persona's vision model). Done first so even an
    # "unchanged" frame keeps the cache + hash fresh for path B.
    _latest_frame[session_id] = (image_bytes, mime_type, time.monotonic())

    # Change-gate (memory only): skip the vision caption + note when the frame
    # is ~identical to the last one — captioning every static frame is wasteful
    # and the note would just be a duplicate. Robust to the captured avatar
    # overlay via the lenient same-screen threshold. ``force`` always persists.
    changed = True
    if frame_hash:
        prev = _last_hash.get(session_id)
        if prev is not None:
            dist = _hamming(prev, frame_hash)
            if dist is not None:
                changed = dist >= _same_screen_threshold()
        _last_hash[session_id] = frame_hash
    if not changed and not force:
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
    # caption is stored in a searchable note.
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
        force=force,
    )
    # Best-effort hygiene — the ambient buffer ages out wholesale; frames
    # that mattered were promoted into the conversation record. Runs in the
    # BACKGROUND: awaiting it inside the upload request once wedged the
    # event loop for tens of seconds (each deleted note rebuilt the
    # full-vault index sidecars inline — watchdog-restarted the process
    # mid-sweep on a 6k-note vault). The sidecar rebuild is coalesced +
    # off-loop since executor 2.64.3; the sweep still must not hold the
    # upload hostage. The hourly throttle inside the sweep is unchanged.
    # Wrapped: this is BOOKKEEPING after the observation is already written
    # and returned-worthy. Letting it raise threw away a completed save and
    # reported failure to the client — which is exactly what happened.
    try:
        existing = _prune_tasks.get(session_id)
        if existing is None or existing.done():
            task = asyncio.create_task(_prune_old_observations(session_id, storage_root))
            _prune_tasks[session_id] = task
            task.add_done_callback(
                lambda t, sid=session_id: _prune_tasks.pop(sid, None) and None
            )
    except Exception:  # noqa: BLE001
        logger.debug("[%s] observation prune scheduling skipped", session_id, exc_info=True)
    return result
