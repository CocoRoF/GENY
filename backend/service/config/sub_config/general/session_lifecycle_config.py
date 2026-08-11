"""세션 수명 — 켜둘 것인가, 재워둘 것인가.

Two things happen to a quiet session, and only one of them is about
memory:

  RUNNING → IDLE   after ``idle_transition_seconds``. A flag. The
                   AgentSession, its pipeline, its memory provider and
                   its embedding client all stay fully resident; the
                   next request flips it back. Nothing is reclaimed.

  IDLE → 축출      after ``idle_evict_seconds``. THIS is the one that
                   frees RAM: the session is torn down, its store
                   record and on-disk memory kept, and the next access
                   rehydrates it — same id, same conversation, plus a
                   cold start.

Eviction was written for a scale this host does not have. Measured on
production (2026-08-11): a resident session costs 64–87 MB, of which
64 MB was one embedder table that every session held its own identical
copy of. Since geny-memory-adaptor 1.11.0 that table is shared, so an
additional resident session costs 0–23 MB — proportional to what it
actually remembers. Ten sessions kept awake is well under 1 GB on a
31 GB host.

What eviction buys in return is a cold start on the next message: the
memory warm-up has been observed to blow its 90 s budget and let a turn
proceed *without* memory. Coming back after half an hour is not a rare
way to use an agent, so that trade is a poor one at this size — hence
``keep_sessions_awake``, and hence its default.

The values here are read on EVERY idle scan, so changing them in
settings takes effect within one tick — no restart.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import env_sync, read_env_defaults


@register_config
@dataclass
class SessionLifecycleConfig(BaseConfig):
    """세션을 언제 재우고 언제 해제할지."""

    # ── 항상 켜두기 ──
    #: When True, no session is ever torn down for being quiet. Sessions
    #: start and stop only when someone says so. This does NOT pin
    #: sessions that were never started — it stops the host from
    #: unstarting them.
    keep_sessions_awake: bool = True

    # ── 시간 ──
    #: RUNNING → IDLE. Display state only; frees nothing.
    idle_transition_seconds: int = 600
    #: IDLE → teardown. Ignored entirely when ``keep_sessions_awake``.
    #: 0 also disables it (kept for the pre-existing env contract).
    idle_evict_seconds: int = 1800

    _ENV_MAP = {
        "keep_sessions_awake": "GENY_KEEP_SESSIONS_AWAKE",
        "idle_transition_seconds": "GENY_IDLE_TRANSITION_SECONDS",
        "idle_evict_seconds": "GENY_IDLE_EVICT_SECONDS",
    }

    # ──────────────────────────────────────────────────────────────────
    # BaseConfig interface
    # ──────────────────────────────────────────────────────────────────

    @classmethod
    def get_default_instance(cls) -> "SessionLifecycleConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "session_lifecycle"

    @classmethod
    def get_display_name(cls) -> str:
        return "Session Lifecycle"

    @classmethod
    def get_description(cls) -> str:
        return (
            "Whether a quiet session is kept warm or torn down to reclaim "
            "memory. Keeping sessions awake costs 0–23 MB each and removes "
            "the cold start on the next message."
        )

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        return "power"

    @classmethod
    def get_i18n(cls) -> Dict[str, Dict[str, Any]]:
        return {
            "ko": {
                "display_name": "세션 수명",
                "description": (
                    "조용한 세션을 계속 켜둘지, 메모리를 회수하려고 해제할지. "
                    "켜둔 세션 하나는 0~23MB 를 쓰고, 대신 다음 메시지에서 "
                    "기억이 다시 올라오길 기다리지 않아도 됩니다."
                ),
                "groups": {
                    "awake": "항상 켜두기",
                    "timing": "시간",
                },
            },
            "en": {
                "groups": {
                    "awake": "Keep awake",
                    "timing": "Timing",
                },
            },
        }

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="keep_sessions_awake",
                field_type=FieldType.BOOLEAN,
                label="세션을 항상 켜둡니다",
                description=(
                    "켜면 세션은 사용자가 시작하고 사용자가 멈출 때까지 그대로 "
                    "남습니다 — 조용하다는 이유로 호스트가 내리지 않습니다. "
                    "상주 비용은 세션당 0~23MB 이고, 대신 다음 메시지에서 "
                    "기억이 다시 올라오기를 기다리는 콜드 스타트가 사라집니다. "
                    "끄면 아래 시간이 지난 세션을 해제하고, 다음 접근에 같은 "
                    "대화 그대로 되살립니다(기억 복구에 시간이 걸립니다)."
                ),
                default=True,
                group="awake",
                apply_change=env_sync("GENY_KEEP_SESSIONS_AWAKE"),
            ),
            ConfigField(
                name="idle_evict_seconds",
                field_type=FieldType.NUMBER,
                label="유휴 세션 해제 대기 (초)",
                description=(
                    "이만큼 아무 활동이 없으면 세션을 해제해 메모리를 "
                    "회수합니다. 대화와 디스크 기억은 보존되며 다음 접근에 "
                    "되살아납니다. 0 이면 해제하지 않음. "
                    "위 '항상 켜두기'가 켜져 있으면 이 값은 무시됩니다. "
                    "900초 미만은 900초로 올림 — 유휴 전환(기본 600초)과 "
                    "너무 가까우면 막 잠든 세션을 곧바로 내리게 됩니다."
                ),
                default=1800,
                min_value=0,
                max_value=86400,
                group="timing",
                apply_change=env_sync("GENY_IDLE_EVICT_SECONDS"),
            ),
            ConfigField(
                name="idle_transition_seconds",
                field_type=FieldType.NUMBER,
                label="유휴 표시 전환 (초)",
                description=(
                    "이만큼 조용하면 세션을 '유휴'로 표시합니다. 표시일 뿐 "
                    "메모리를 놓아주지는 않습니다 — 세션은 그대로 상주하고 "
                    "다음 요청에 즉시 되돌아옵니다."
                ),
                default=600,
                min_value=60,
                max_value=86400,
                group="timing",
                apply_change=env_sync("GENY_IDLE_TRANSITION_SECONDS"),
            ),
        ]
