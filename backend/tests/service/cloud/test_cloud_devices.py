"""Cloud device registry — effect-proving tests.

The rail draws the attachment graph around the cloud:

    [folder] ── [computer] ── [CLOUD] ── [agent]

so a computer has to stay nameable while it is switched off. A live-socket
list alone would drop a sleeping laptop out of the picture entirely, which
reads as "unpaired", and the folders it shares would lose the machine they
belong to. These tests pin that behaviour.
"""

from __future__ import annotations

import pytest

from service.cloud import store


@pytest.fixture
def user(tmp_path, monkeypatch):
    # cloud_root() reads this env var first, so the registry lands in tmp.
    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    return "tester"


def test_a_registered_computer_survives_going_offline(user):
    """The whole point: registration is not a live-socket view."""
    store.remember_device(user, "dev-1", "내-데스크톱")

    rows = store.known_devices(user)
    assert [r["device_id"] for r in rows] == ["dev-1"]
    assert rows[0]["device_name"] == "내-데스크톱"
    assert rows[0]["last_seen"] > 0


def test_reconnecting_updates_in_place_instead_of_duplicating(user):
    store.remember_device(user, "dev-1", "old-name")
    store.remember_device(user, "dev-1", "new-name")

    rows = store.known_devices(user)
    assert len(rows) == 1, "a reconnect must not add a second row"
    assert rows[0]["device_name"] == "new-name"


def test_most_recent_attachment_comes_first(user):
    store.remember_device(user, "dev-1", "first")
    store.remember_device(user, "dev-2", "second")
    assert [r["device_id"] for r in store.known_devices(user)] == ["dev-2", "dev-1"]


def test_unknown_device_id_is_not_recorded(user):
    """The WS hello defaults to 'unknown' when a client sends no id; that is
    not a machine and must not become a rail entry."""
    store.remember_device(user, "unknown", "nope")
    store.remember_device(user, "", "nope")
    assert store.known_devices(user) == []


def test_registry_is_bounded(user):
    for i in range(store._MAX_DEVICES + 25):
        store.remember_device(user, f"dev-{i}", f"pc-{i}")
    assert len(store.known_devices(user)) == store._MAX_DEVICES


def test_forget_drops_only_the_named_machine(user):
    store.remember_device(user, "dev-1", "keep")
    store.remember_device(user, "dev-2", "drop")

    remaining = store.forget_device(user, "dev-2")
    assert [r["device_id"] for r in remaining] == ["dev-1"]
    assert [r["device_id"] for r in store.known_devices(user)] == ["dev-1"]


def test_corrupt_registry_reads_as_empty_not_as_an_error(user, tmp_path):
    """A probe of the attachment graph must never take the page down."""
    store.remember_device(user, "dev-1", "pc")
    store._devices_file(user).write_text("{ not json", encoding="utf-8")
    assert store.known_devices(user) == []
