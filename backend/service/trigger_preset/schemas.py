"""Pydantic schemas for Trigger Presets.

A Trigger Preset replaces the hard-coded thinking-trigger ladder
(:mod:`service.vtuber.thinking_trigger`) with a configurable bundle that
can be swapped per VTuber session. The shape mirrors the *Environment*
preset surface (CRUD-friendly, JSON-per-id on disk) so the same UI
patterns that manage env presets can manage trigger presets.

### Runtime semantics

When a VTuber session has a preset attached the trigger service:

1. Reads ``timing`` to drive idle thresholds + adaptive backoff.
2. Picks the *phase* whose ``[min_consecutive, max_consecutive]`` range
   covers the session's consecutive-trigger count.
3. Filters that phase's ``events`` by each linked category's
   ``conditions`` (sub-worker busy/idle, time-window, …), drops events
   whose conditions don't hold *now*, normalises remaining ``weight``
   values to 100, and runs a single roulette roll.
4. Pulls a random prompt from the chosen category's
   ``prompts[locale]``; falls back to ``"en"`` if the active locale
   has no entries.

### Extensibility

Both ``phases`` and ``categories`` are free lists — operators add their
own entries (custom phases, custom categories, extra prompt variants)
without code changes. ``kind='thinking'|'activity'`` controls the
``[THINKING_TRIGGER]`` / ``[ACTIVITY_TRIGGER]`` family tag, which the
agent's reflection-metadata builder reads downstream.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


# ── Runtime sub-models ────────────────────────────────────────────


class TriggerTiming(BaseModel):
    """Idle-window timing knobs for the trigger loop.

    Defaults match the historical hardcoded constants in
    :mod:`service.vtuber.thinking_trigger` — a preset that is left
    untouched on save behaves identically to the no-preset path.
    """

    base_idle_seconds: float = Field(120.0, ge=5.0)
    max_idle_seconds: float = Field(3600.0, ge=5.0)
    tick_interval_seconds: float = Field(30.0, ge=5.0)
    sub_worker_working_cooldown_seconds: float = Field(90.0, ge=0.0)
    adaptive_scale_triggers: int = Field(20, ge=1)

    @model_validator(mode="after")
    def _enforce_max_ge_base(self) -> "TriggerTiming":
        if self.max_idle_seconds < self.base_idle_seconds:
            raise ValueError(
                "max_idle_seconds must be >= base_idle_seconds"
            )
        return self


class TimeBoundaries(BaseModel):
    """Hour-of-day boundaries (KST) for ``time_window`` conditions."""

    morning_start: int = Field(6, ge=0, le=23)
    afternoon_start: int = Field(12, ge=0, le=23)
    evening_start: int = Field(18, ge=0, le=23)
    night_start: int = Field(22, ge=0, le=23)


TriggerKind = Literal["thinking", "activity"]
TimeWindow = Literal["morning", "afternoon", "evening", "night"]


class CategoryConditions(BaseModel):
    """Optional gates evaluated at fire-time before the roulette pick.

    All fields are advisory — leaving every gate empty keeps the
    category eligible whenever its phase is active. The runtime
    evaluates each gate in order and drops the event entry as soon as
    any gate fails for the current session/clock.
    """

    requires_sub_worker_busy: bool = False
    """Only fire while the linked Sub-Worker session is executing."""

    requires_sub_worker_idle: bool = False
    """Only fire while the linked Sub-Worker is idle (and exists)."""

    time_window: Optional[TimeWindow] = None
    """Fire only when KST hour matches the named window."""

    min_consecutive: Optional[int] = Field(None, ge=0)
    """Floor on the session's consecutive-trigger count."""

    max_consecutive: Optional[int] = Field(None, ge=0)
    """Ceiling on the session's consecutive-trigger count."""


class TriggerCategory(BaseModel):
    """One firable bucket — a labelled tag + locale-specific prompts."""

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field("", max_length=120)
    kind: TriggerKind = "thinking"
    conditions: CategoryConditions = Field(default_factory=CategoryConditions)
    cooldown_seconds: float = Field(0.0, ge=0.0)
    prompts: Dict[str, List[str]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _ensure_locale_lists(self) -> "TriggerCategory":
        # Coerce single-string locales into single-element lists so the
        # FE can post {"en": "foo"} for trivial single-prompt cases.
        clean: Dict[str, List[str]] = {}
        for locale, value in self.prompts.items():
            if isinstance(value, str):
                clean[locale] = [value]
            elif isinstance(value, list):
                clean[locale] = [str(v) for v in value if str(v).strip()]
            else:
                raise ValueError(
                    f"prompts[{locale!r}] must be a string or list of strings"
                )
        self.prompts = clean
        return self


class PhaseEvent(BaseModel):
    """One slot in a phase's roulette table."""

    category_id: str = Field(..., min_length=1)
    weight: float = Field(1.0, ge=0.0)


class TriggerPhase(BaseModel):
    """A consecutive-count bracket plus a weighted event list.

    ``max_consecutive=None`` means "and above" — the open-ended top
    bracket. Phases are matched in list order with the first range
    covering the session's count winning, so place narrower ranges
    earlier. (Validation also runs an order/overlap check.)
    """

    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field("", max_length=120)
    min_consecutive: int = Field(..., ge=0)
    max_consecutive: Optional[int] = Field(None, ge=0)
    events: List[PhaseEvent] = Field(default_factory=list)

    @model_validator(mode="after")
    def _enforce_max_ge_min(self) -> "TriggerPhase":
        if (
            self.max_consecutive is not None
            and self.max_consecutive < self.min_consecutive
        ):
            raise ValueError(
                f"phase {self.id!r}: max_consecutive "
                f"({self.max_consecutive}) < min_consecutive "
                f"({self.min_consecutive})"
            )
        return self


# ── Manifest (full preset payload) ────────────────────────────────


class TriggerPresetManifest(BaseModel):
    """Full body of a trigger preset (everything except outer metadata).

    The same model is used both as request payload (PATCH/PUT) and as
    the on-disk dict — controllers serialise via ``model_dump`` and
    re-validate on read.
    """

    enabled: bool = True
    timing: TriggerTiming = Field(default_factory=TriggerTiming)
    time_boundaries: TimeBoundaries = Field(default_factory=TimeBoundaries)
    phases: List[TriggerPhase] = Field(default_factory=list)
    categories: List[TriggerCategory] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_internal_consistency(self) -> "TriggerPresetManifest":
        # Unique ids
        cat_ids = [c.id for c in self.categories]
        if len(cat_ids) != len(set(cat_ids)):
            raise ValueError("category ids must be unique")
        phase_ids = [p.id for p in self.phases]
        if len(phase_ids) != len(set(phase_ids)):
            raise ValueError("phase ids must be unique")

        # Every event must reference a known category
        known = set(cat_ids)
        for phase in self.phases:
            for ev in phase.events:
                if ev.category_id not in known:
                    raise ValueError(
                        f"phase {phase.id!r} references unknown "
                        f"category_id={ev.category_id!r}"
                    )

        return self


# ── Persisted record ──────────────────────────────────────────────


class TriggerPresetRecord(BaseModel):
    """The full on-disk record for one preset.

    JSON layout::

        {
          "id": "ab12...",
          "name": "내 VTuber 기본",
          "description": "...",
          "tags": ["preset"],
          "created_at": "2026-05-06T...",
          "updated_at": "2026-05-06T...",
          "manifest": { ...TriggerPresetManifest... }
        }
    """

    id: str
    name: str
    description: str = ""
    tags: List[str] = Field(default_factory=list)
    created_at: str
    updated_at: str
    manifest: TriggerPresetManifest


# ── Controller request / response models ──────────────────────────


class CreateTriggerPresetRequest(BaseModel):
    """``POST /api/trigger-presets`` payload.

    ``manifest`` is optional; when omitted the service seeds a fresh
    record from :func:`service.trigger_preset.defaults.default_manifest`
    so the FE can hand the operator a working baseline immediately.
    ``clone_from`` deep-copies an existing preset's manifest under a
    new id (mirrors environment duplicate semantics).
    """

    name: str = Field(..., min_length=1, max_length=120)
    description: str = ""
    tags: List[str] = Field(default_factory=list)
    manifest: Optional[TriggerPresetManifest] = None
    clone_from: Optional[str] = Field(
        None,
        description="Source preset id — when set, copy that preset's manifest.",
    )

    @model_validator(mode="after")
    def _exclusive_seed(self) -> "CreateTriggerPresetRequest":
        if self.manifest is not None and self.clone_from:
            raise ValueError(
                "Provide either ``manifest`` or ``clone_from``, not both."
            )
        return self


class UpdateTriggerPresetRequest(BaseModel):
    """``PATCH /api/trigger-presets/{id}`` — top-level metadata only."""

    name: Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = None
    tags: Optional[List[str]] = None


class ReplaceManifestRequest(BaseModel):
    """``PUT /api/trigger-presets/{id}/manifest`` — full body replacement."""

    manifest: TriggerPresetManifest


class DuplicateTriggerPresetRequest(BaseModel):
    new_name: str = Field(..., min_length=1, max_length=120)


class TriggerPresetSummaryResponse(BaseModel):
    """List-view summary card."""

    id: str
    name: str
    description: str
    tags: List[str]
    created_at: str
    updated_at: str
    enabled: bool
    phase_count: int
    category_count: int


class TriggerPresetListResponse(BaseModel):
    presets: List[TriggerPresetSummaryResponse]


class TriggerPresetDetailResponse(BaseModel):
    id: str
    name: str
    description: str
    tags: List[str]
    created_at: str
    updated_at: str
    manifest: TriggerPresetManifest


class CreateTriggerPresetResponse(BaseModel):
    id: str


__all__ = [
    "CategoryConditions",
    "PhaseEvent",
    "TimeBoundaries",
    "TriggerCategory",
    "TriggerKind",
    "TriggerPhase",
    "TriggerPresetManifest",
    "TriggerPresetRecord",
    "TriggerTiming",
    "TimeWindow",
    # Controller
    "CreateTriggerPresetRequest",
    "CreateTriggerPresetResponse",
    "DuplicateTriggerPresetRequest",
    "ReplaceManifestRequest",
    "TriggerPresetDetailResponse",
    "TriggerPresetListResponse",
    "TriggerPresetSummaryResponse",
    "UpdateTriggerPresetRequest",
]
