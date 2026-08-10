"""Retention has to be reachable from settings, not only from a shell.

The numbers that decide what the agent keeps are the user's call, not a
deployment detail. They live on the Long-Term Memory card, and changing one
must take effect without a restart — the card writes the same environment
key the sweep reads, so there is one value, not two that can disagree.
"""

from __future__ import annotations

import pytest

from service.config.sub_config.general.ltm_config import LTMConfig

RETENTION_FIELDS = {
    "observation_max_notes": "GENY_SCREEN_OBS_MAX_NOTES",
    "note_retention_days": "GENY_NOTE_RETENTION_DAYS",
    "note_retention_max_per_category": "GENY_NOTE_RETENTION_MAX_PER_CATEGORY",
}


def _fields():
    return {f.name: f for f in LTMConfig.get_fields_metadata()}


@pytest.mark.parametrize("name", sorted(RETENTION_FIELDS))
def test_the_setting_is_on_the_card(name):
    field = _fields().get(name)
    assert field is not None, f"{name} is not editable in settings"
    assert field.group == "retention"
    assert field.label, "an unlabelled field is not a setting anyone can use"
    assert field.description


@pytest.mark.parametrize("name,env_key", sorted(RETENTION_FIELDS.items()))
def test_changing_it_takes_effect_without_a_restart(name, env_key, monkeypatch):
    """THE property. A card that only writes JSON while the sweep reads the
    environment gives two values that drift apart silently."""
    # Register the key with monkeypatch FIRST so its teardown restores it —
    # `apply_change` writes os.environ directly, which monkeypatch cannot
    # see, and a leaked value silently reconfigures every later test.
    monkeypatch.setenv(env_key, "__unset__")
    field = _fields()[name]
    assert field.apply_change is not None, f"{name} never reaches the running process"

    field.apply_change(None, 7)

    import os
    assert os.environ[env_key] == "7"


def test_the_observation_default_is_a_short_buffer():
    """Screen observations are what was on screen a moment ago, not a record
    of anything that happened. The default keeps a working buffer."""
    assert LTMConfig.get_default_instance().observation_max_notes == 20


def test_every_retention_setting_can_be_turned_off():
    """Zero must be reachable: a user who wants to keep everything should
    not have to edit code."""
    fields = _fields()
    for name in RETENTION_FIELDS:
        assert fields[name].min_value == 0, f"{name} cannot be disabled"


def test_the_sweep_reads_what_the_card_writes(monkeypatch):
    """Ties the two ends together rather than trusting the key strings."""
    from service.memory import note_retention as nr
    from service.vtuber import screen_observation as so

    for env_key in RETENTION_FIELDS.values():
        monkeypatch.setenv(env_key, "__unset__")
    _fields()["observation_max_notes"].apply_change(None, 5)
    _fields()["note_retention_days"].apply_change(None, 11)
    _fields()["note_retention_max_per_category"].apply_change(None, 99)

    assert so._max_observation_notes() == 5
    assert nr.retention_days() == 11
    assert nr.max_per_category() == 99
