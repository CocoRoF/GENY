"""Canonical emotion-tag taxonomy — cycle 20260422_5 (X7).

Pins invariants of the single-source-of-truth tag table:

- Primary six axes each get a 1:1 coefficient (preserves pre-X7 math).
- Every tag targets only recognized paths (mood.<axis> / bond.<axis>).
- Coefficients are finite floats (no NaN / inf regressions).
- ``RECOGNIZED_TAGS`` stays in lockstep with ``AFFECT_TAG_MAPPING``.
- Case-insensitive lookup for ``coefficients_for``.
"""

from __future__ import annotations

import math

import pytest

from service.affect.taxonomy import (
    AFFECT_TAG_MAPPING,
    MOOD_AXES,
    RECOGNIZED_TAGS,
    coefficients_for,
)


def test_primary_six_axes_have_1to1_mood_coefficient() -> None:
    """The original 6 tags must apply a coefficient of 1.0 to their
    matching mood axis, so pre-X7 magnitudes are byte-stable."""
    for axis in MOOD_AXES:
        coeffs = AFFECT_TAG_MAPPING[axis]
        assert coeffs.get(f"mood.{axis}") == 1.0, (
            f"primary tag {axis!r} must have coefficient 1.0 on mood.{axis}"
        )


def test_every_tag_targets_only_known_paths() -> None:
    """All coefficient paths must target ``mood.<axis>`` or
    ``bond.<affection|trust|familiarity|dependency>``. No typos."""
    valid_mood = {f"mood.{a}" for a in MOOD_AXES}
    valid_bond = {"bond.affection", "bond.trust", "bond.familiarity", "bond.dependency"}
    valid = valid_mood | valid_bond
    for tag, coeffs in AFFECT_TAG_MAPPING.items():
        for path in coeffs:
            assert path in valid, (
                f"tag {tag!r} targets unknown path {path!r}"
            )


def test_coefficients_are_finite_floats() -> None:
    for tag, coeffs in AFFECT_TAG_MAPPING.items():
        for path, coeff in coeffs.items():
            assert math.isfinite(coeff), (
                f"{tag!r} -> {path!r} has non-finite coefficient {coeff!r}"
            )


def test_recognized_tags_matches_mapping_keys() -> None:
    """RECOGNIZED_TAGS is the canonical iteration order; it must equal
    the mapping's keys so the sanitizer / emitter / prompt all agree."""
    assert RECOGNIZED_TAGS == tuple(AFFECT_TAG_MAPPING.keys())


def test_recognized_tags_includes_user_reported_problematic_tags() -> None:
    """User-reported tags that were leaking into chat (wonder,
    amazement, satisfaction, curiosity) must be in the taxonomy now."""
    for name in ("wonder", "amazement", "satisfaction", "curiosity"):
        assert name in RECOGNIZED_TAGS, (
            f"{name!r} missing from RECOGNIZED_TAGS — re-adds a leak risk"
        )


def test_coefficients_for_is_case_insensitive() -> None:
    assert coefficients_for("Joy") == AFFECT_TAG_MAPPING["joy"]
    assert coefficients_for("WONDER") == AFFECT_TAG_MAPPING["wonder"]


def test_coefficients_for_unknown_returns_empty() -> None:
    assert coefficients_for("bewildered") == {}
    assert coefficients_for("") == {}
    assert coefficients_for("not_a_tag_12345") == {}


def test_aliases_share_coefficients() -> None:
    """Aliases deliberately share mappings so the emitter doesn't
    bias based on which synonym the model chose."""
    assert AFFECT_TAG_MAPPING["curious"] == AFFECT_TAG_MAPPING["curiosity"]
    assert AFFECT_TAG_MAPPING["excited"] == AFFECT_TAG_MAPPING["excitement"]
