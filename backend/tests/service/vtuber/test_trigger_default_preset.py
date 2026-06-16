"""Geny ships a real, persisted default trigger preset (screen-enabled).

Two guarantees:
  1. The TriggerPresetService seeds a ``default`` preset (from the bundled
     manifest, which includes the screen-observation category) — idempotent, so
     user edits survive restarts.
  2. A VTuber session with NO explicitly-attached preset resolves to that seeded
     default at runtime — so the provided default is what actually operates and
     editing it in 트리거 관리 affects every default session.
"""

from __future__ import annotations

import pytest

from service.trigger_preset import DEFAULT_PRESET_ID, set_trigger_preset_service
from service.trigger_preset.service import TriggerPresetService


def test_get_default_seeds_screen_enabled_preset(tmp_path) -> None:
    svc = TriggerPresetService(storage_path=str(tmp_path))  # file-only, no DB
    rec = svc.get_default()

    assert rec is not None
    assert rec.id == DEFAULT_PRESET_ID
    cat_ids = {c.id for c in rec.manifest.categories}
    assert "screen_observation" in cat_ids
    screen = next(c for c in rec.manifest.categories if c.id == "screen_observation")
    assert screen.requires_screen_active is True

    # Idempotent: second call doesn't create a duplicate file.
    again = svc.get_default()
    assert again.id == DEFAULT_PRESET_ID
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_seed_preserves_user_edits(tmp_path) -> None:
    """Re-seeding must NOT clobber a user's edited default."""
    svc = TriggerPresetService(storage_path=str(tmp_path))
    svc.get_default()  # seed
    svc.replace_manifest  # noqa: B018 — just asserting attribute exists
    # Edit the default's name via metadata, then re-run the seed path.
    svc.update_metadata(DEFAULT_PRESET_ID, name="내가 고친 기본")
    svc._seed_default_locked()  # would re-create only if missing
    rec = svc.get_default()
    assert rec.name == "내가 고친 기본"  # preserved


@pytest.fixture
def _clear_preset_singleton():
    yield
    set_trigger_preset_service(None)


def test_session_without_preset_resolves_to_seeded_default(
    tmp_path, _clear_preset_singleton,
) -> None:
    from service.vtuber.thinking_trigger import ThinkingTriggerService

    preset_svc = TriggerPresetService(storage_path=str(tmp_path))
    preset_svc.get_default()  # seed the default
    set_trigger_preset_service(preset_svc)

    trig = ThinkingTriggerService()
    manifest = trig._resolve_manifest("sid-with-no-explicit-preset")

    # Resolved to the seeded default → carries the screen category.
    assert any(c.id == "screen_observation" for c in manifest.categories)


def test_explicit_preset_still_wins_over_default(
    tmp_path, _clear_preset_singleton,
) -> None:
    from service.vtuber.thinking_trigger import ThinkingTriggerService

    preset_svc = TriggerPresetService(storage_path=str(tmp_path))
    preset_svc.get_default()
    # A custom preset without the screen category.
    custom_id = preset_svc.create("커스텀")
    rec = preset_svc.get(custom_id)
    rec.manifest.categories = [c for c in rec.manifest.categories if c.id != "screen_observation"]
    preset_svc.replace_manifest(custom_id, rec.manifest)
    set_trigger_preset_service(preset_svc)

    trig = ThinkingTriggerService()
    trig.attach_preset("sid-custom", custom_id)
    manifest = trig._resolve_manifest("sid-custom")

    assert not any(c.id == "screen_observation" for c in manifest.categories)
