"""Endpoint test for /api/skills/list (G7.4 — controller/skills_controller.py).

Audit gap (post_cycle_audit §3): the endpoint had no test of its
own. The underlying ``list_skills()`` is covered by the skills
install test suite, but the *endpoint shape* (response_model
serialisation, auth dependency, empty-list shape) needs its own
assertion so a future change to SkillSummary fields fails loud
here instead of slipping through to a frontend serialisation error.

Skipped when fastapi isn't importable (test venv).
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest

pytest.importorskip("fastapi")

from controller.skills_controller import (  # noqa: E402
    SkillListResponse,
    SkillSummary,
    list_skills_endpoint,
)


@pytest.fixture
def isolated_home(monkeypatch, tmp_path) -> Iterator[Path]:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".geny" / "skills").mkdir(parents=True, exist_ok=True)
    monkeypatch.delenv("GENY_ALLOW_USER_SKILLS", raising=False)
    yield tmp_path


def _write_user_skill(home: Path, skill_id: str) -> None:
    skill_dir = home / "home" / ".geny" / "skills" / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
id: {skill_id}
name: {skill_id.replace('_', ' ').title()}
description: test skill {skill_id}
allowed_tools: []
---
body
""",
        encoding="utf-8",
    )


# ── Response shape ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_returns_response_model(isolated_home: Path) -> None:
    """Endpoint must return a SkillListResponse — even with bundled
    skills only (no user opt-in)."""
    resp = await list_skills_endpoint(_auth={})
    assert isinstance(resp, SkillListResponse)
    assert isinstance(resp.skills, list)
    for skill in resp.skills:
        assert isinstance(skill, SkillSummary)


@pytest.mark.asyncio
async def test_list_includes_user_skills_when_opted_in(
    isolated_home: Path, monkeypatch
) -> None:
    monkeypatch.setenv("GENY_ALLOW_USER_SKILLS", "1")
    _write_user_skill(isolated_home, "user_endpoint_skill")
    resp = await list_skills_endpoint(_auth={})
    ids = {s.id for s in resp.skills if s.id}
    assert "user_endpoint_skill" in ids


@pytest.mark.asyncio
async def test_list_excludes_user_skills_when_not_opted_in(
    isolated_home: Path,
) -> None:
    _write_user_skill(isolated_home, "should_not_appear")
    resp = await list_skills_endpoint(_auth={})
    ids = {s.id for s in resp.skills if s.id}
    assert "should_not_appear" not in ids


@pytest.mark.asyncio
async def test_each_summary_has_allowed_tools_as_list(isolated_home: Path) -> None:
    """allowed_tools must serialise as a JSON list — never None,
    never a tuple. Frontend code does ``skill.allowed_tools.length``
    which would crash on None."""
    resp = await list_skills_endpoint(_auth={})
    for skill in resp.skills:
        assert isinstance(skill.allowed_tools, list)


@pytest.mark.asyncio
async def test_env_re_export_takes_effect_on_next_call(
    isolated_home: Path, monkeypatch
) -> None:
    """Docstring promises the env is read at request time. A
    re-export should change the response on the very next call —
    no server restart, no module reload."""
    _write_user_skill(isolated_home, "late_reveal_skill")

    # First call: env unset → user skill hidden.
    resp1 = await list_skills_endpoint(_auth={})
    ids1 = {s.id for s in resp1.skills if s.id}
    assert "late_reveal_skill" not in ids1

    # Operator opts in.
    monkeypatch.setenv("GENY_ALLOW_USER_SKILLS", "1")

    # Second call (same process) → user skill now visible.
    resp2 = await list_skills_endpoint(_auth={})
    ids2 = {s.id for s in resp2.skills if s.id}
    assert "late_reveal_skill" in ids2
