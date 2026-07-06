"""Memory attachment serving — `_find_memory_attachment` resolution.

Observation notes embed frames by bare name (`![[<id>.jpg]]`) while the
image lives date-bucketed at `memory/observations/<YYYY-MM-DD>/<id>.jpg`.
The resolver must find it by filename search, refuse traversal/globs, and
serve images only.
"""

from __future__ import annotations

from pathlib import Path

from controller.memory_controller import _find_memory_attachment


def _vault(tmp_path: Path) -> Path:
    memory = tmp_path / "memory"
    bucket = memory / "observations" / "2026-07-05"
    bucket.mkdir(parents=True)
    (bucket / "dbb64ec4e2b0.jpg").write_bytes(b"\xff\xd8jpegbytes")
    (memory / "observations" / "20260705-080538-dbb64ec4e2b0.md").write_text(
        "![[dbb64ec4e2b0.jpg]]", encoding="utf-8",
    )
    return memory


def test_resolves_date_bucketed_frame_by_bare_name(tmp_path: Path) -> None:
    memory = _vault(tmp_path)
    found = _find_memory_attachment(memory, "dbb64ec4e2b0.jpg")
    assert found is not None
    assert found.name == "dbb64ec4e2b0.jpg"
    assert found.read_bytes().startswith(b"\xff\xd8")


def test_missing_file_returns_none(tmp_path: Path) -> None:
    memory = _vault(tmp_path)
    assert _find_memory_attachment(memory, "nope.jpg") is None


def test_markdown_notes_never_served(tmp_path: Path) -> None:
    memory = _vault(tmp_path)
    assert (
        _find_memory_attachment(memory, "20260705-080538-dbb64ec4e2b0.md") is None
    )


def test_traversal_and_glob_names_rejected(tmp_path: Path) -> None:
    memory = _vault(tmp_path)
    # Path components are stripped to the basename → still resolves safely.
    found = _find_memory_attachment(memory, "../../etc/dbb64ec4e2b0.jpg")
    assert found is not None and found.name == "dbb64ec4e2b0.jpg"
    # Glob metacharacters and hidden/absolute shapes are refused outright.
    assert _find_memory_attachment(memory, "*.jpg") is None
    assert _find_memory_attachment(memory, "[a]b.jpg") is None
    assert _find_memory_attachment(memory, ".hidden.jpg") is None


def test_symlink_escape_blocked(tmp_path: Path) -> None:
    memory = _vault(tmp_path)
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"\x89PNGoutside")
    link = memory / "observations" / "escape.png"
    try:
        link.symlink_to(outside)
    except OSError:  # filesystem without symlink support
        return
    assert _find_memory_attachment(memory, "escape.png") is None
