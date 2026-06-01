"""Bundled Custom-Tool samples — one self-contained source per tool.

PR #851 originally shipped these as ``builtin_alias`` overlays.
PR #853 flipped them to ``python_inline`` but used a single 600-line
blob (the entire ``blog_agent_tools.py``) for every row, so opening
``blog_agent_status`` in the form modal showed four unrelated classes.

This PR uses the right shape: each sample row carries **only its own
tool's source** + the helpers that tool actually uses. The seeder
reads each ``sample_sources/blog/<tool>.py`` file at boot and writes
its content into a single ``python_inline`` DB row.

Adding a new sample = drop a new ``.py`` under
``sample_sources/<bundle>/`` and add an entry to ``_SAMPLE_SPECS``.

The seeder is idempotent:
  * existing rows for a sample name are skipped (operator edits
    survive).
  * legacy ``builtin_alias`` rows from PR #851 and the single-blob
    ``python_inline`` rows from the first PR #853 cut both get
    upgraded in place to the new self-contained form.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from logging import getLogger
from pathlib import Path
from typing import List, Optional

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


@dataclass(frozen=True)
class _SampleSpec:
    """One sample tool — points at its own self-contained source file."""

    name: str
    source_file: str  # relative to ``sample_sources/``
    class_name: str
    description: str
    capabilities: ToolCapabilities


_SAMPLE_SOURCES_DIR = (
    Path(__file__).resolve().parent / "sample_sources"
)


# Capability presets shared across the bundled blog samples.
_BLOG_CAP_LOOKUP = ToolCapabilities(
    concurrency_safe=True, read_only=True, idempotent=True,
    network_egress=True, max_result_chars=20_000,
)
_BLOG_CAP_DELEGATE = ToolCapabilities(
    concurrency_safe=False, read_only=False, idempotent=False,
    network_egress=True, max_result_chars=4_000,
)
_BLOG_CAP_CANCEL = ToolCapabilities(
    concurrency_safe=False, read_only=False, idempotent=True,
    network_egress=True, max_result_chars=2_000,
)


_SAMPLE_SPECS: List[_SampleSpec] = [
    _SampleSpec(
        name="blog_agent_delegate",
        source_file="blog/blog_agent_delegate.py",
        class_name="BlogAgentDelegateTool",
        description=(
            "외부 블로그 AI Agent 에게 글쓰기 / 편집 / 관리 작업을 비동기 위임. "
            "fire-and-poll 패턴 — 즉시 task_id 만 반환하고 결과는 inbox 로 도착."
        ),
        capabilities=_BLOG_CAP_DELEGATE,
    ),
    _SampleSpec(
        name="blog_agent_status",
        source_file="blog/blog_agent_status.py",
        class_name="BlogAgentStatusTool",
        description="blog_agent_delegate 로 시작된 위임 작업의 진행 상황 조회.",
        capabilities=_BLOG_CAP_LOOKUP,
    ),
    _SampleSpec(
        name="blog_agent_cancel",
        source_file="blog/blog_agent_cancel.py",
        class_name="BlogAgentCancelTool",
        description="진행 중인 위임 task 를 취소.",
        capabilities=_BLOG_CAP_CANCEL,
    ),
    _SampleSpec(
        name="blog_agent_list_posts",
        source_file="blog/blog_agent_list_posts.py",
        class_name="BlogAgentListPostsTool",
        description="블로그 포스트 목록 조회 — 카테고리/태그/검색 필터링.",
        capabilities=_BLOG_CAP_LOOKUP,
    ),
    _SampleSpec(
        name="blog_agent_get_post",
        source_file="blog/blog_agent_get_post.py",
        class_name="BlogAgentGetPostTool",
        description="블로그 포스트 상세 조회 (slug 기준).",
        capabilities=_BLOG_CAP_LOOKUP,
    ),
]


def _read_source(rel_path: str) -> str:
    """Load one sample's source file. Returns empty string when the file
    is missing so the seeder skips silently rather than crashing."""
    try:
        return (_SAMPLE_SOURCES_DIR / rel_path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _spec_to_definition(spec: _SampleSpec) -> Optional[CustomToolDefinition]:
    """Build a :class:`CustomToolDefinition` from a spec.

    Returns ``None`` when the source file is missing (post-cleanup state).
    """
    src = _read_source(spec.source_file)
    if not src:
        return None
    return CustomToolDefinition(
        id=uuid.uuid4().hex,
        name=spec.name,
        description=spec.description,
        # Inline tool's own auto-generated schema (post PR #847 hygiene)
        # is what the LLM sees once the row is registered. The DB-row
        # schema is informational only.
        input_schema={
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        backend_kind="python_inline",
        config=PythonInlineConfig(
            source_code=src,
            class_name=spec.class_name,
        ),
        capabilities=spec.capabilities,
        is_sample=True,
        enabled=True,
    )


def _blog_samples() -> List[CustomToolDefinition]:
    """The full bundled-blog sample list. Skips entries whose source
    file is missing (post-cleanup state)."""
    out: List[CustomToolDefinition] = []
    for spec in _SAMPLE_SPECS:
        defn = _spec_to_definition(spec)
        if defn is not None:
            out.append(defn)
    return out


def _needs_upgrade(existing: CustomToolDefinition, fresh: CustomToolDefinition) -> bool:
    """Return True when an existing row should be flipped to the fresh
    sample shape.

    Two upgrade paths today:
      1. Legacy ``builtin_alias`` rows from PR #851 — backend_kind
         doesn't match.
      2. Single-blob ``python_inline`` rows from the first PR #853 cut —
         backend_kind matches but ``source_code`` is the giant
         monolithic file instead of the self-contained per-tool source.
         Detected by length: a sample's fresh source is <12KB; the
         legacy single-blob is 20KB+.

    User-edited rows (sample=False OR materially different source) are
    NOT touched.
    """
    # Path 1: builtin_alias holdovers.
    if existing.backend_kind == "builtin_alias":
        return existing.is_sample is True

    # Path 2: same python_inline kind, but old monolithic source.
    if existing.backend_kind == "python_inline":
        if not existing.is_sample:
            # Operator's own python_inline tool — never touch.
            return False
        if not isinstance(existing.config, PythonInlineConfig):
            return False
        if not isinstance(fresh.config, PythonInlineConfig):
            return False
        # Monolithic blob defines all five Blog* classes; the
        # self-contained source defines exactly one. Length is a cheap
        # signal (15KB+ → blob, ~12KB or less → per-tool).
        if len(existing.config.source_code) > 15_000 and len(fresh.config.source_code) < 12_000:
            return True
        # Different class_name shouldn't happen for sample rows, but
        # if it does the row is broken — replace.
        if existing.config.class_name != fresh.config.class_name:
            return True
    return False


def seed_samples(store: CustomToolStore) -> int:
    """Insert / upgrade bundled samples.

    Returns the number of rows inserted or upgraded. Idempotent — re-runs
    are no-ops once every sample row is on the latest shape.
    """
    changed = 0
    for sample in _blog_samples():
        existing = store.get_by_name(sample.name)
        if existing is None:
            try:
                store.create(sample)
                changed += 1
            except CustomToolNameTaken:
                continue
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "CustomToolStore: failed to seed sample %s: %s",
                    sample.name, exc,
                )
            continue

        if _needs_upgrade(existing, sample):
            # Preserve immutable / structural fields on upgrade.
            sample.id = existing.id
            sample.is_sample = existing.is_sample
            try:
                store.replace(existing.id, sample)
                changed += 1
                logger.info(
                    "CustomToolStore: upgraded sample %s to self-contained source",
                    sample.name,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "CustomToolStore: failed to upgrade sample %s: %s",
                    sample.name, exc,
                )

    if changed:
        logger.info(
            "CustomToolStore: seeded/upgraded %d sample tool(s)", changed,
        )
    return changed
