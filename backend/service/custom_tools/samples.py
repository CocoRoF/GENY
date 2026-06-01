"""Bundled Custom-Tool samples.

PR #5 (Phase D) of cycle 20260525_1 originally shipped these as
``builtin_alias`` overlays on top of the in-repo Python file. That was
a shortcut — it didn't actually move the implementation to the web,
just dressed up Python. The follow-up (current PR) makes them real
``python_inline`` samples: the full Python source lives in the DB row,
the operator can read + edit the actual code in the form modal, and
the eventual goal is to delete ``backend/tools/custom/blog_agent_tools.py``
once the DB-side is verified.

Each of the five blog tools gets its own row. The five rows share the
same ``source_code`` body (the entire blog_agent_tools.py contents);
only ``class_name`` differs, telling the adapter which class to
instantiate from the exec'd namespace. Helpers + capability presets
get defined once per row at exec time — wasteful but acceptable for
five samples, and it keeps each sample self-contained in the web UI
(an operator inspecting the source sees the helpers it depends on).

The seeder is idempotent: existing rows with a sample's name (sample
or user-edited) stay put. The seeder also actively *upgrades* legacy
``builtin_alias`` rows (from the previous PR) to ``python_inline`` so
the operator's existing samples flip to the new editable form
automatically on the next boot.
"""

from __future__ import annotations

import uuid
from logging import getLogger
from pathlib import Path
from typing import List

from service.custom_tools.models import (
    BuiltinAliasConfig,
    CustomToolDefinition,
    PythonInlineConfig,
    ToolCapabilities,
)
from service.custom_tools.store import (
    CustomToolNameTaken,
    CustomToolStore,
)

logger = getLogger(__name__)


# Path to the in-repo blog_agent_tools.py — its contents become the
# source body of every blog sample row. Kept here as the SOT so when
# the operator edits the source in the web UI, the next reboot won't
# clobber their edits (the seeder only inserts new rows / upgrades
# legacy alias rows — never overwrites existing python_inline rows).
_BLOG_TOOLS_PY = (
    Path(__file__).resolve().parent.parent.parent
    / "tools" / "custom" / "blog_agent_tools.py"
)


def _read_blog_source() -> str:
    """Load the in-repo blog tools source. Returns empty string when
    the file has been removed (post-cleanup state) so the seeder skips
    silently rather than crashing on boot."""
    try:
        return _BLOG_TOOLS_PY.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _blog_samples() -> List[CustomToolDefinition]:
    """The 5 blog_agent_* tools as ``python_inline`` samples.

    Each row carries the full blog_agent_tools.py source (with helpers
    + every class definition); ``class_name`` selects which
    BaseTool subclass the adapter instantiates. The shared service
    code (BlogTaskRegistry, AsyncBlogAgentClient, deliver_external_result)
    lives in ``service/blog_agent/*`` and is reachable via normal
    ``import service.blog_agent.*`` from inside the inline source.
    """
    src = _read_blog_source()
    if not src:
        return []

    cap_lookup = ToolCapabilities(
        concurrency_safe=True, read_only=True, idempotent=True,
        network_egress=True, max_result_chars=20_000,
    )
    cap_delegate = ToolCapabilities(
        concurrency_safe=False, read_only=False, idempotent=False,
        network_egress=True, max_result_chars=4_000,
    )
    cap_cancel = ToolCapabilities(
        concurrency_safe=False, read_only=False, idempotent=True,
        network_egress=True, max_result_chars=2_000,
    )

    base = [
        (
            "blog_agent_delegate",
            "BlogAgentDelegateTool",
            cap_delegate,
            "외부 블로그 AI Agent 에게 글쓰기 / 편집 / 관리 작업을 비동기 위임. "
            "fire-and-poll 패턴 — 즉시 task_id 만 반환하고 결과는 inbox 로 도착.",
        ),
        (
            "blog_agent_status",
            "BlogAgentStatusTool",
            cap_lookup,
            "blog_agent_delegate 로 시작된 위임 작업의 진행 상황 조회.",
        ),
        (
            "blog_agent_cancel",
            "BlogAgentCancelTool",
            cap_cancel,
            "진행 중인 위임 task 를 취소.",
        ),
        (
            "blog_agent_list_posts",
            "BlogAgentListPostsTool",
            cap_lookup,
            "블로그 포스트 목록 조회 — 카테고리/태그/검색 필터링.",
        ),
        (
            "blog_agent_get_post",
            "BlogAgentGetPostTool",
            cap_lookup,
            "블로그 포스트 상세 조회 (slug 기준).",
        ),
    ]

    out: List[CustomToolDefinition] = []
    for name, source_class, caps, desc in base:
        out.append(
            CustomToolDefinition(
                id=uuid.uuid4().hex,
                name=name,
                description=desc,
                # Empty schema — the inline BaseTool subclass's own
                # auto-generated schema (post PR #847 hygiene) is what
                # the LLM sees once the row is registered with the
                # ToolLoader. The DB-row schema is informational only
                # for the form-modal preview.
                input_schema={
                    "type": "object",
                    "properties": {},
                    "required": [],
                    "additionalProperties": False,
                },
                backend_kind="python_inline",
                config=PythonInlineConfig(
                    source_code=src,
                    class_name=source_class,
                ),
                capabilities=caps,
                is_sample=True,
                enabled=True,
            )
        )
    return out


def _upgrade_legacy_alias(
    store: CustomToolStore,
    sample: CustomToolDefinition,
) -> bool:
    """Replace an existing ``builtin_alias`` row for the same name with
    the new ``python_inline`` form. Returns True if an upgrade happened.

    The previous PR shipped these as ``builtin_alias`` — overlays on
    top of the in-repo Python. The user pushback was correct: that
    doesn't move the implementation to the web. This upgrade flips
    legacy rows to ``python_inline`` automatically so operators don't
    have to re-seed manually. User-edited ``python_inline`` rows are
    NOT touched (we only upgrade rows that still carry the legacy
    alias config + sample marker).
    """
    existing = store.get_by_name(sample.name)
    if existing is None:
        return False
    if existing.backend_kind != "builtin_alias":
        return False
    if not isinstance(existing.config, BuiltinAliasConfig):
        return False
    # Same name → preserve the row's id + is_sample status; flip
    # backend_kind + config to the new python_inline form. ``replace``
    # in the store keeps ``is_sample`` and ``id`` pinned anyway.
    sample.id = existing.id
    sample.is_sample = existing.is_sample
    store.replace(existing.id, sample)
    return True


def seed_samples(store: CustomToolStore) -> int:
    """Insert Geny-shipped python_inline sample rows + upgrade legacy
    ``builtin_alias`` rows from the previous PR.

    Returns the number of rows actually changed (inserts + upgrades).
    Safe to call multiple times — a row whose name already maps to a
    ``python_inline`` row is left alone, so operator edits survive.
    """
    changed = 0
    for sample in _blog_samples():
        # 1) upgrade legacy alias row in place if present.
        if _upgrade_legacy_alias(store, sample):
            logger.info(
                "CustomToolStore: upgraded legacy alias → python_inline (%s)",
                sample.name,
            )
            changed += 1
            continue

        # 2) skip if a row (any kind) already exists for this name.
        if store.get_by_name(sample.name) is not None:
            continue

        # 3) fresh insert.
        try:
            store.create(sample)
            changed += 1
        except CustomToolNameTaken:
            # Race with another worker / cold-start replay — fine.
            continue
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "CustomToolStore: failed to seed sample %s: %s",
                sample.name, exc,
            )

    if changed:
        logger.info(
            "CustomToolStore: seeded/upgraded %d sample tool(s)", changed,
        )
    return changed
