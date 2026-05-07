"""Unit tests for ``service.whiteboard.attachments``.

The helper guarantees we rely on:

  * ``save_attachment`` returns a relative path under ``_attachments/``
    that round-trips through ``read_attachment``.
  * Path-traversal attempts in ``read_attachment`` / ``delete_attachment``
    are refused (defence in depth — the controller already strips the
    prefix, but the helper must not trust callers).
  * Collisions get a random suffix instead of overwriting.
  * ``append_capture_log`` is best-effort (never raises) and writes
    one JSON object per line.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from service.whiteboard.attachments import (
    append_capture_log,
    captures_log_path,
    delete_attachment,
    list_attachments,
    read_attachment,
    safe_attachment_name,
    save_attachment,
)


@pytest.fixture()
def vault(tmp_path: Path) -> str:
    vault_dir = tmp_path / "_user_opsidian" / "alice"
    vault_dir.mkdir(parents=True)
    return str(vault_dir)


def test_save_attachment_round_trip(vault: str) -> None:
    rel = save_attachment(vault, b"hello", suggested_name="memo.txt")
    assert rel.startswith("_attachments/")
    assert rel.endswith(".txt")
    assert read_attachment(vault, rel) == b"hello"


def test_save_attachment_collisions_get_unique_names(vault: str) -> None:
    a = save_attachment(vault, b"one", suggested_name="screen.png")
    b = save_attachment(vault, b"two", suggested_name="screen.png")
    assert a != b
    assert read_attachment(vault, a) == b"one"
    assert read_attachment(vault, b) == b"two"


def test_save_attachment_strips_path_components(vault: str) -> None:
    rel = save_attachment(vault, b"hi", suggested_name="../etc/passwd.txt")
    # The leaf basename is what we keep — directory components are stripped.
    assert "/etc/" not in rel
    assert rel.endswith(".txt")


def test_read_attachment_rejects_traversal(vault: str) -> None:
    # Drop a sentinel in the parent directory.
    parent = Path(vault).parent
    (parent / "secret").write_bytes(b"top secret")
    # Attempt to read it via the attachments helper should refuse.
    assert read_attachment(vault, "../secret") is None


def test_delete_attachment_round_trip(vault: str) -> None:
    rel = save_attachment(vault, b"x", suggested_name="x.bin")
    assert delete_attachment(vault, rel) is True
    assert read_attachment(vault, rel) is None


def test_delete_attachment_rejects_traversal(vault: str) -> None:
    parent = Path(vault).parent
    sentinel = parent / "important"
    sentinel.write_bytes(b"important")
    assert delete_attachment(vault, "../important") is False
    assert sentinel.exists()


def test_list_attachments_orders_results(vault: str) -> None:
    save_attachment(vault, b"1", suggested_name="b.png")
    save_attachment(vault, b"2", suggested_name="a.png")
    items = list(list_attachments(vault))
    assert items[0].endswith("a.png")
    assert items[1].endswith("b.png")


def test_safe_attachment_name_uses_default_ext_for_extensionless() -> None:
    name = safe_attachment_name("memo", default_ext="txt")
    assert name.endswith(".txt")


def test_safe_attachment_name_falls_back_when_empty() -> None:
    name = safe_attachment_name(None, default_ext="png")
    assert name.endswith(".png")
    assert "/" not in name


def test_append_capture_log_writes_one_json_per_line(vault: str) -> None:
    append_capture_log(vault, {"capture_id": "1", "kind": "screen"})
    append_capture_log(vault, {"capture_id": "2", "kind": "clipboard"})
    log = captures_log_path(vault)
    lines = log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    parsed = [json.loads(line) for line in lines]
    assert parsed[0]["capture_id"] == "1"
    assert parsed[1]["kind"] == "clipboard"
