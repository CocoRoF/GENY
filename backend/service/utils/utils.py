"""
Common utility functions.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

# NOTE: there is intentionally no fixed ``KST`` constant — use the configured
# helpers below (``configured_timezone`` / ``now_kst``) so all time operations
# follow the TimezoneConfig setting rather than a hardcoded +9 offset.


def _configured_tz() -> ZoneInfo:
    """``ZoneInfo`` for the configured timezone — the single source of truth.

    The IANA name comes from :class:`TimezoneConfig` (the user-editable setting),
    synced live to ``GENY_TIMEZONE`` via its ``env_sync`` apply_change callback.
    Falls back to the legacy ``TIMEZONE`` env (compose default) then ``Asia/Seoul``
    (the config's own default). Read at call time so a live timezone change takes
    effect without a restart.
    """
    name = os.environ.get("GENY_TIMEZONE") or os.environ.get("TIMEZONE") or "Asia/Seoul"
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo("Asia/Seoul")


def configured_timezone() -> ZoneInfo:
    """Canonical public accessor for the configured timezone (see ``_configured_tz``)."""
    return _configured_tz()


def _configured_tz_abbr() -> str:
    """Return a short abbreviation like KST, JST, UTC, etc."""
    return datetime.now(_configured_tz()).strftime("%Z")


def now_kst() -> datetime:
    """
    Return current time in the **configured** timezone.

    Despite the legacy name the function respects ``GENY_TIMEZONE``.

    Returns:
        datetime: Current time in the configured timezone.
    """
    return datetime.now(_configured_tz())


def to_kst(dt: datetime) -> datetime:
    """
    Convert given datetime to the **configured** timezone.

    Args:
        dt: datetime object to convert.

    Returns:
        datetime: datetime converted to the configured timezone.
    """
    if dt.tzinfo is None:
        # For naive datetime, assume UTC and convert
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_configured_tz())


def format_kst(dt: datetime) -> str:
    """
    Format datetime as a string in the **configured** timezone.

    Args:
        dt: datetime object to format.

    Returns:
        str: String in "YYYY-MM-DD HH:MM:SS <TZ>" format.
    """
    tz = _configured_tz()
    local_time = to_kst(dt)
    abbr = local_time.strftime("%Z")
    return local_time.strftime(f"%Y-%m-%d %H:%M:%S {abbr}")


# ── Time-of-day labelling ──────────────────────────────────────────
#
# Hour-of-day → part-of-day label, in the **configured** timezone. Five
# buckets so dawn (새벽) is distinct from night (밤) and morning (아침).
# Boundaries align with the trigger ``TimeBoundaries`` (6/12/18/22) plus a
# dawn split below 6 — kept here (not hard-coded at call sites) so every
# surface that tells the persona the time of day agrees.
_TIME_OF_DAY_KO = {
    "dawn": "새벽",
    "morning": "아침",
    "afternoon": "낮",
    "evening": "저녁",
    "night": "밤",
}
_TIME_OF_DAY_EN = {
    "dawn": "dawn",
    "morning": "morning",
    "afternoon": "afternoon",
    "evening": "evening",
    "night": "night",
}
_WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"]


def time_of_day_key(hour: int) -> str:
    """Map an hour (0-23) to a part-of-day key (dawn/morning/afternoon/evening/night)."""
    if hour < 6:
        return "dawn"
    if hour < 12:
        return "morning"
    if hour < 18:
        return "afternoon"
    if hour < 22:
        return "evening"
    return "night"


def time_of_day_label(dt: Optional[datetime] = None, locale: str = "ko") -> str:
    """Part-of-day label (새벽/아침/낮/저녁/밤) for *dt* in the configured tz.

    ``dt=None`` uses the current configured-timezone time.
    """
    local = now_kst() if dt is None else to_kst(dt)
    table = _TIME_OF_DAY_KO if locale == "ko" else _TIME_OF_DAY_EN
    return table[time_of_day_key(local.hour)]


def time_context_phrase(dt: Optional[datetime] = None, locale: str = "ko") -> str:
    """One-line, unambiguous current-time phrase for prompts.

    e.g. ``일요일 아침, 09:51 KST`` (ko) / ``Sunday morning, 09:51 KST`` (en).
    Gives the persona an explicit time-of-day anchor so it never guesses
    (e.g. calling a 09:51 morning "evening").
    """
    local = now_kst() if dt is None else to_kst(dt)
    abbr = local.strftime("%Z")
    tod = time_of_day_label(local, locale)
    if locale == "ko":
        weekday = _WEEKDAY_KO[local.weekday()] + "요일"
        return f"{weekday} {tod}, {local.strftime('%H:%M')} {abbr}"
    weekday = local.strftime("%A")
    return f"{weekday} {tod}, {local.strftime('%H:%M')} {abbr}"
