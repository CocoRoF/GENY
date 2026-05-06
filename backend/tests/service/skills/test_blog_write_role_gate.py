"""BLOG_AGENT_DELEGATION_PLAN.md § Phase 4 — blog-write Skill role gate.

  - install_skill_registry(role=None) — 모든 skills 등록 (catalog 노출)
  - install_skill_registry(role="vtuber") — blog-write 포함
  - install_skill_registry(role="worker") — blog-write 제외
"""
from __future__ import annotations

import pytest

pytest.importorskip("geny_executor.skills")

from service.skills.install import (
    _SKILL_ROLE_RESTRICTIONS,
    _skill_allowed_for_role,
    install_skill_registry,
)


def test_role_restrictions_pin_blog_write_to_vtuber() -> None:
    assert "blog-write" in _SKILL_ROLE_RESTRICTIONS
    assert _SKILL_ROLE_RESTRICTIONS["blog-write"] == frozenset({"vtuber"})


def _make_fake_skill(skill_id: str):
    class _S:
        def __init__(self, sid):
            self.id = sid

    return _S(skill_id)


def test_unknown_skill_id_is_unrestricted() -> None:
    s = _make_fake_skill("draft-pr")
    assert _skill_allowed_for_role(s, role=None) is True
    assert _skill_allowed_for_role(s, role="worker") is True
    assert _skill_allowed_for_role(s, role="vtuber") is True


def test_blog_write_only_resolves_for_vtuber() -> None:
    s = _make_fake_skill("blog-write")
    # 글로벌 catalog (role=None) 에서는 노출
    assert _skill_allowed_for_role(s, role=None) is True
    assert _skill_allowed_for_role(s, role="vtuber") is True
    assert _skill_allowed_for_role(s, role="VTuber") is True   # case-insensitive
    # Worker 계열은 차단
    assert _skill_allowed_for_role(s, role="worker") is False
    assert _skill_allowed_for_role(s, role="developer") is False
    assert _skill_allowed_for_role(s, role="researcher") is False


def test_install_role_filters_blog_write_for_worker() -> None:
    """실제 install 경로 — worker 로 호출 시 blog-write 가 빠진다."""
    _, vtuber_skills = install_skill_registry(role="vtuber")
    _, worker_skills = install_skill_registry(role="worker")

    vtuber_ids = {getattr(s, "id", None) for s in vtuber_skills}
    worker_ids = {getattr(s, "id", None) for s in worker_skills}

    assert "blog-write" in vtuber_ids
    assert "blog-write" not in worker_ids


def test_install_role_none_keeps_blog_write() -> None:
    """글로벌 listing 엔드포인트 호환 — role 미지정 시 모든 skill 노출."""
    _, all_skills = install_skill_registry(role=None)
    ids = {getattr(s, "id", None) for s in all_skills}
    assert "blog-write" in ids
