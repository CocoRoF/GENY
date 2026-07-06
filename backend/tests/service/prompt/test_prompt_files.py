"""Static prompt-file regression tests (2026-07 prompt diet).

Keyword-level guards over ``prompts/worker.md`` / ``prompts/vtuber.md``
so a casual edit that drops a runtime protocol (the structured
``[SUB_WORKER_RESULT]`` contract, loop markers, naming policy) is
caught at CI time before it hits the model.

Diet principles these tests now also enforce (2026-07):

* Tool mechanics are NOT restated in prompts — tool schemas carry them.
  vtuber.md must stay free of the desktop_* walkthrough (now a
  conditional ``computer_use`` PromptSection) and of the 25-tag emotion
  taxonomy dump (the affect emitter accepts any lowercase tag).
* Runtime-injected guidance is NOT duplicated — first-encounter /
  newborn-trope coaching lives in the [Acclimation]/[StageVoiceGuide]
  blocks (service/persona/blocks.py), not in the role file.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_PROMPTS_DIR = Path(__file__).resolve().parents[3] / "prompts"

_INCLUDE_RE = re.compile(r"\{\{\s*include:\s*([^}]+?)\s*\}\}")


def _read_resolved(name: str) -> str:
    """Read a role prompt and inline its ``{{include: …}}`` directives,
    mirroring the prompt builder — so assertions run against what the
    model actually receives."""
    text = (_PROMPTS_DIR / name).read_text(encoding="utf-8")

    def _sub(m: "re.Match[str]") -> str:
        return (_PROMPTS_DIR / m.group(1).strip()).read_text(encoding="utf-8")

    return _INCLUDE_RE.sub(_sub, text)


@pytest.fixture(scope="module")
def worker_md() -> str:
    return _read_resolved("worker.md")


@pytest.fixture(scope="module")
def vtuber_md() -> str:
    return _read_resolved("vtuber.md")


# ── worker.md — paired Sub-Worker protocol ───────────────────────────


def test_worker_md_has_paired_sub_worker_section(worker_md: str) -> None:
    assert "## When You Are a Paired Sub-Worker" in worker_md
    # Conditional opener so an unpaired Worker ignores the block.
    assert "applies **only** when" in worker_md.lower()


def test_worker_md_describes_subworker_result_protocol(worker_md: str) -> None:
    assert "[SUB_WORKER_RESULT]" in worker_md
    assert "status: ok | partial | failed" in worker_md
    assert "summary:" in worker_md
    assert "details:" in worker_md
    assert "artifacts:" in worker_md


def test_worker_md_subworker_protocol_includes_example(worker_md: str) -> None:
    """A worked example improves smaller-model adherence."""
    assert "status: ok" in worker_md


def test_worker_md_forbids_persona_language_in_reply(worker_md: str) -> None:
    """The Sub-Worker owns facts; the VTuber owns tone."""
    assert "no greetings, no persona" in worker_md.lower()


def test_worker_md_marks_task_complete_as_loop_internal(worker_md: str) -> None:
    """``[TASK_COMPLETE]`` is a pipeline loop marker and never replaces
    the structured DM — without this a tool-only turn leaves the VTuber
    nothing to paraphrase."""
    text = worker_md.lower()
    assert "pipeline loop marker" in text
    assert "never replaces" in text


# ── vtuber.md — trigger payload handling ─────────────────────────────


def test_vtuber_md_subworker_trigger_parses_structured_payload(
    vtuber_md: str,
) -> None:
    """Paraphrase-not-paste, with every canonical field referenced."""
    low = vtuber_md.lower()
    assert "paraphrase" in low and "never paste" in low
    for field in ("status", "summary", "details", "artifacts"):
        assert f"`{field}`" in vtuber_md or f"{field}:" in vtuber_md, field
    for verdict in ("ok", "partial", "failed"):
        assert f"`{verdict}`" in vtuber_md, verdict


def test_vtuber_md_warns_against_dumping_details(vtuber_md: str) -> None:
    assert "never dump" in vtuber_md.lower()


def test_vtuber_md_silent_close_on_unstructured_payload(vtuber_md: str) -> None:
    """Blank/unstructured result body → silent close-of-loop, and the
    known failure phrase is called out explicitly."""
    assert "closes the loop silently" in vtuber_md.lower()
    assert "출력이 없네요" in vtuber_md


def test_vtuber_md_triggers_are_internal_processes(vtuber_md: str) -> None:
    for tag in ("[THINKING_TRIGGER]", "[ACTIVITY_TRIGGER]", "[SUB_WORKER_RESULT]"):
        assert tag in vtuber_md, tag
    assert "[SILENT]" in vtuber_md


# ── vtuber.md — memory ladder include ────────────────────────────────


def test_vtuber_md_includes_memory_ladder_guide(vtuber_md: str) -> None:
    """The shared ladder template must resolve into the prompt. It
    deliberately does NOT restate memory tool schemas — it only conveys
    the vault shape the tools can't."""
    assert "## Your Memory" in vtuber_md
    assert "Vault Map" in vtuber_md
    assert "conversations" in vtuber_md


# ── vtuber.md — naming policy ────────────────────────────────────────


def test_vtuber_md_name_policy(vtuber_md: str) -> None:
    """session_name is an internal handle, never the persona's name."""
    assert "character_display_name" in vtuber_md
    assert "internal handle" in vtuber_md
    assert "never adopt" in vtuber_md.lower()


# ── 2026-07 prompt diet — duplication guards ─────────────────────────


def test_vtuber_md_stays_lean(vtuber_md: str) -> None:
    """The diet cut the role file from 5.8KB to ~2.5KB (resolved).
    Growth past ~3.6KB means someone is restating tool/runtime knowledge
    — put it in a tool description, a runtime block, or a conditional
    PromptSection instead. (3.6KB accommodates the memory ladder's
    Fact Ledger line — vault-shape knowledge, the ladder's charter.)"""
    assert len(vtuber_md) < 3600, f"vtuber.md grew to {len(vtuber_md)}B"


def test_vtuber_md_has_no_desktop_tool_walkthrough(vtuber_md: str) -> None:
    """desktop_* mechanics live in tool schemas + the conditional
    computer_use PromptSection (sections.py) — never in the role file."""
    assert "desktop_screenshot" not in vtuber_md
    assert "desktop_click" not in vtuber_md
    assert "local_mcp_list" not in vtuber_md


def test_vtuber_md_has_no_first_encounter_duplication(vtuber_md: str) -> None:
    """First-encounter coaching is runtime-injected per band via
    [Acclimation]/[StageVoiceGuide] (service/persona/blocks.py) — the
    role file must not carry a stale copy."""
    assert "First-Encounter" not in vtuber_md
    assert "갓 태어난" not in vtuber_md


def test_first_encounter_guidance_lives_in_runtime_blocks() -> None:
    """The coaching the role file dropped must exist at its real home."""
    from service.persona.blocks import _ACCLIMATION_BANDS

    first = _ACCLIMATION_BANDS[0][1]
    assert first.band == "first-encounter"
    low = first.guidance.lower()
    assert "first" in low and "newborn" in low


def test_computer_use_section_is_conditional() -> None:
    """The desktop guardrails inject only for computer-use sessions."""
    from service.prompt.sections import build_agent_prompt

    with_cu = build_agent_prompt(role="vtuber", computer_use_enabled=True)
    without_cu = build_agent_prompt(role="vtuber", computer_use_enabled=False)
    assert "Desktop control" in with_cu
    assert "never Bash" in with_cu
    assert "Desktop control" not in without_cu


def test_emotion_tags_cover_primary_axes_only(vtuber_md: str) -> None:
    """The prompt names the six primary axes; the emitter maps nuance
    tags itself (AFFECT_TAG_MAPPING + lowercase safety net), so the
    25-tag taxonomy dump must not return."""
    for tag in ("[joy]", "[sadness]", "[anger]", "[fear]", "[calm]", "[excitement]"):
        assert tag in vtuber_md, tag
    # Spot-check that the old exhaustive dump stayed dead.
    assert "[amazement]" not in vtuber_md
    assert "[satisfaction]" not in vtuber_md
