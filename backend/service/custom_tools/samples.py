"""Bundled Custom-Tool samples.

PR #5 (Phase D) of cycle 20260525_1. Seeds the ``custom_tools`` table
with the existing ``blog_agent_*`` family as ``builtin_alias`` rows so
they appear in the env-management → 커스텀 도구 tab as Geny-shipped
samples. The Python implementations under
``backend/tools/custom/blog_agent_tools.py`` are unchanged — these
rows are pure metadata overlays the operator can duplicate and edit
to learn the Custom Tools surface.

The seeder is idempotent: it skips any sample whose ``name`` already
exists in the table (regardless of ``is_sample`` — once an operator
forks ``blog_agent_status`` into a user copy named
``blog_agent_status_copy``, the original keeps its slot). Disabled
sample rows are *not* re-enabled, so an operator who hides a sample
keeps it hidden.

Each sample's tool body still flows through the regular ToolLoader
roster from the filesystem, so removing the sample row from the DB
only hides it from the UI — the actual blog tools stay callable from
manifests / sessions until the underlying Python file is removed.
"""

from __future__ import annotations

import uuid
from logging import getLogger
from typing import List

from service.custom_tools.models import (
    BuiltinAliasConfig,
    CustomToolDefinition,
    ToolCapabilities,
)
from service.custom_tools.store import (
    CustomToolNameTaken,
    CustomToolStore,
)

logger = getLogger(__name__)


# ── Sample definitions ──────────────────────────────────────────


def _blog_samples() -> List[CustomToolDefinition]:
    """The 5 blog_agent_* tools as builtin_alias samples.

    Each entry duplicates the LLM-facing description from
    ``blog_agent_tools.py``'s class — the alias points back to the
    same Python class for execution. ``capabilities`` mirror the
    ``_LOOKUP`` / ``_DELEGATE`` / ``_CANCEL`` profiles declared on
    the original classes.
    """
    cap_lookup = ToolCapabilities(
        concurrency_safe=True,
        read_only=True,
        idempotent=True,
        network_egress=True,
        max_result_chars=20_000,
    )
    cap_delegate = ToolCapabilities(
        concurrency_safe=False,
        read_only=False,
        idempotent=False,
        network_egress=True,
        max_result_chars=4_000,
    )
    cap_cancel = ToolCapabilities(
        concurrency_safe=False,
        read_only=False,
        idempotent=True,
        network_egress=True,
        max_result_chars=2_000,
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
                # Empty schema — the underlying BaseTool's own
                # auto-generated schema (post PR #847 hygiene) is what
                # actually gets exposed to the LLM via the alias
                # adapter. The DB row's schema is informational only
                # for the UI to display "no args" cleanly.
                input_schema={
                    "type": "object",
                    "properties": {},
                    "required": [],
                    "additionalProperties": False,
                },
                backend_kind="builtin_alias",
                config=BuiltinAliasConfig(
                    source_module="blog_agent_tools",
                    source_class=source_class,
                ),
                capabilities=caps,
                is_sample=True,
                enabled=True,
            )
        )
    return out


def seed_samples(store: CustomToolStore) -> int:
    """Insert Geny-shipped sample rows. Returns the number actually
    inserted (skipping any that already exist).

    Called from ``main.py`` after :meth:`CustomToolStore.set_database`.
    Safe to call multiple times — name collisions are skipped, so an
    operator-edited sample copy or an existing seed row stays intact.
    """
    inserted = 0
    for sample in _blog_samples():
        if store.get_by_name(sample.name) is not None:
            continue
        try:
            store.create(sample)
            inserted += 1
        except CustomToolNameTaken:
            # Race with another worker / cold-start replay — fine.
            continue
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "CustomToolStore: failed to seed sample %s: %s",
                sample.name, exc,
            )
    if inserted:
        logger.info(
            "CustomToolStore: seeded %d sample tool(s)", inserted,
        )
    return inserted
