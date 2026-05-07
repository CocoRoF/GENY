"""Pydantic schemas for Trigger Presets.

Cycle 20260507 redesign — collapsed the previous "phases × categories"
two-tier model into a single tier:

  Category  =  "발화 상황" — when this fires (conditions) + which
                prompts are in this situation (with sub-weights).
  Prompt    =  natural-language content only. The system generates
                the [TRIGGER:<id>] / [autonomous_signal: …] tags at
                fire time so operators never write them by hand.

Runtime semantics::

  ① find every Category whose conditions hold under the current
     scenario (consec count, sub-worker state, time window, cooldown)
  ② weighted roulette across matching categories (Category.weight)
     to pick a single situation
  ③ weighted roulette across that category's prompts
     (TriggerPromptVariant.weight) to pick the exact wording
  ④ render: ``[KIND_TRIGGER:cat_id] [autonomous_signal: …] {content}``

This collapses the old (phase, category, event) triple into a flat
list of categories with consec range as just-another-condition, which
is what operators want when authoring a preset.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


# ── Runtime sub-models ────────────────────────────────────────────


class TriggerTiming(BaseModel):
    """Idle-window timing knobs for the trigger loop.

    Defaults match the historical hardcoded constants in
    :mod:`service.vtuber.thinking_trigger`.
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


class TriggerPromptVariant(BaseModel):
    """One natural-language prompt inside a category.

    The runtime picks one variant per fire via weighted random over
    ``weight``; weights are *within-category* (a separate roulette runs
    across categories first).

    ``content`` is keyed by locale (``en``, ``ko``, …). Each value is
    the **raw natural language**: no tag prefixes, no ``autonomous_signal``,
    no metadata. Those are auto-generated at fire time from the parent
    category's metadata so the operator only has to write words.
    """

    weight: float = Field(1.0, ge=0.0)
    content: Dict[str, str] = Field(
        default_factory=dict,
        description="locale → natural-language text",
    )

    @model_validator(mode="after")
    def _trim_content(self) -> "TriggerPromptVariant":
        # Coerce values to strings; drop blank locales.
        clean: Dict[str, str] = {}
        for locale, value in self.content.items():
            text = str(value).strip()
            if text:
                clean[locale] = text
        self.content = clean
        return self


class TriggerCategory(BaseModel):
    """One firable situation.

    A category bundles three things:

      • **Identity** — id (used in the auto-generated tag), label, kind
      • **Conditions** — when this situation applies. consec range,
        sub-worker state, time window, per-category cooldown. All
        optional; absence = "no restriction on this axis".
      • **Prompts** — natural-language variants. The runtime renders
        ``[KIND_TRIGGER:id] [autonomous_signal: …] {content}`` using
        the category's metadata, so prompt content is operator-friendly
        plain text.
    """

    # ── Identity ──────────────────────────────────────────────
    id: str = Field(..., min_length=1, max_length=64)
    label: str = Field("", max_length=120)
    kind: TriggerKind = "thinking"

    # ── Category-level weight ─────────────────────────────────
    # Drives stage-1 roulette across matching categories.
    weight: float = Field(1.0, ge=0.0)

    # ── Conditions ────────────────────────────────────────────
    consec_min: int = Field(
        0,
        ge=0,
        description=(
            "Lower bound on the session's consecutive-trigger count. "
            "Default 0 = no lower bound."
        ),
    )
    consec_max: Optional[int] = Field(
        None,
        ge=0,
        description=(
            "Upper bound on the consecutive-trigger count. "
            "``None`` = no upper bound (open-ended)."
        ),
    )
    requires_sub_worker_busy: bool = False
    requires_sub_worker_idle: bool = False
    time_window: Optional[TimeWindow] = None
    cooldown_seconds: float = Field(0.0, ge=0.0)

    # ── Output formatting ─────────────────────────────────────
    autonomous_signal: str = Field(
        "",
        description=(
            "Optional content to inject as ``[autonomous_signal: …]``. "
            "Set to empty string to omit. Mostly an internal hint for "
            "the agent — operators rarely need to touch this."
        ),
    )

    # ── Prompts ───────────────────────────────────────────────
    prompts: List[TriggerPromptVariant] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_consec_range(self) -> "TriggerCategory":
        if (
            self.consec_max is not None
            and self.consec_max < self.consec_min
        ):
            raise ValueError(
                f"category {self.id!r}: consec_max ({self.consec_max}) "
                f"< consec_min ({self.consec_min})"
            )
        return self


# ── Manifest ──────────────────────────────────────────────────────


class TriggerPresetManifest(BaseModel):
    """Full body of a trigger preset.

    Cycle 20260507 — phases removed. consec range now lives on each
    category as a regular condition. The runtime fires by:

      1. matching → all categories whose conditions hold
      2. category roulette by ``weight``
      3. prompt roulette by per-prompt ``weight`` inside the picked cat
      4. render with auto-generated tag prefix
    """

    enabled: bool = True
    timing: TriggerTiming = Field(default_factory=TriggerTiming)
    time_boundaries: TimeBoundaries = Field(default_factory=TimeBoundaries)
    categories: List[TriggerCategory] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_unique_ids(self) -> "TriggerPresetManifest":
        ids = [c.id for c in self.categories]
        if len(ids) != len(set(ids)):
            raise ValueError("category ids must be unique")
        return self


# ── Persisted record ──────────────────────────────────────────────


class TriggerPresetRecord(BaseModel):
    """The full on-disk record for one preset."""

    id: str
    name: str
    description: str = ""
    tags: List[str] = Field(default_factory=list)
    created_at: str
    updated_at: str
    manifest: TriggerPresetManifest


# ── Controller request / response models ──────────────────────────


class CreateTriggerPresetRequest(BaseModel):
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
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = None
    tags: Optional[List[str]] = None


class ReplaceManifestRequest(BaseModel):
    manifest: TriggerPresetManifest


class DuplicateTriggerPresetRequest(BaseModel):
    new_name: str = Field(..., min_length=1, max_length=120)


class TriggerPresetSummaryResponse(BaseModel):
    id: str
    name: str
    description: str
    tags: List[str]
    created_at: str
    updated_at: str
    enabled: bool
    category_count: int
    # Total number of prompt variants across all categories — a quick
    # signal of "how rich is this preset" for the list view.
    prompt_count: int


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


# ── Backwards-compatibility aliases ───────────────────────────────
# Old (phase × category × event) callers may still import these
# names; we re-export the new TriggerCategory under the conditions
# name so legacy controllers don't break during the FE migration.
# Unused once the FE catches up — flagged for removal next cycle.

CategoryConditions = TriggerCategory  # legacy import alias
TriggerPhase = TriggerCategory  # ditto


__all__ = [
    "TimeBoundaries",
    "TimeWindow",
    "TriggerCategory",
    "TriggerKind",
    "TriggerPresetManifest",
    "TriggerPresetRecord",
    "TriggerPromptVariant",
    "TriggerTiming",
    # Controller
    "CreateTriggerPresetRequest",
    "CreateTriggerPresetResponse",
    "DuplicateTriggerPresetRequest",
    "ReplaceManifestRequest",
    "TriggerPresetDetailResponse",
    "TriggerPresetListResponse",
    "TriggerPresetSummaryResponse",
    "UpdateTriggerPresetRequest",
    # Legacy aliases (delete next cycle)
    "CategoryConditions",
    "TriggerPhase",
]


# ── Helpers ───────────────────────────────────────────────────────


def render_prompt(category: TriggerCategory, content: str) -> str:
    """Render a fully-formed prompt string from a category + content.

    The runtime calls this *exactly once* per fire. Operators don't
    have to think about the tag format — only the natural language —
    because every prompt that goes out is constructed here::

        [{KIND}_TRIGGER:{cat.id}] [autonomous_signal: {signal}] {content}

    The ``autonomous_signal`` chunk is omitted when the category leaves
    that field empty, matching the historical "fun_*" / "activity_*"
    prompt shape.
    """
    kind_token = "ACTIVITY_TRIGGER" if category.kind == "activity" else "THINKING_TRIGGER"
    head = f"[{kind_token}:{category.id}]"
    parts: List[str] = [head]
    signal = (category.autonomous_signal or "").strip()
    if signal:
        parts.append(f"[autonomous_signal: {signal}]")
    parts.append(content.strip())
    return " ".join(parts)
