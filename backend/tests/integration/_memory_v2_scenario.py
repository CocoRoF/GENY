"""Deterministic synthetic scenario for the Memory v2 redesign.

Memory v2 (`/home/geny-workspace/Geny/plan.md`) introduces a new
`memory/conversations/` source-of-truth category and a chain of
auto-write hooks (conversation_archiver, dm_archiver,
daily_journal_writer). Each Phase / PR makes a localised change to
the chain. The risk is that a downstream PR silently regresses an
upstream invariant — e.g. an entity_bootstrap refactor in PR 16
that breaks the InteractionEvent metadata pinned by PR 2.

This module provides the *deterministic driver* every parity test
runs against. It is **synthetic** — no real LLM, no SDK, no
network. The scenario walks a hand-rolled sequence of
`record_message` calls (with correctly shaped InteractionEvent
metadata) and returns a ``ScenarioSnapshot`` capturing the resulting
on-disk state.

Why a hand-rolled driver instead of replaying real session data:

  * Reproducibility — the same input produces byte-identical output.
  * Hermetic — no dependency on agent_session, claude_agent_sdk,
    persona providers, or any tool registry.
  * Fast — sub-second wall time, runs on every PR's CI.
  * Boundary-pinned — each invariant the plan's section §1 / §2
    promises shows up as an explicit assertion site downstream.

The scenario shape (cf. plan §3 Phase 0):

  * One VTuber session ("vtuber") and one paired Sub-Worker session
    ("worker") sharing a `paired_session_id` reference.
  * Five user ↔ VTuber turns (kind=user_chat, both directions).
  * Three VTuber ↔ Sub-Worker turns (kind=task_request →
    tool_run_summary).
  * One assistant turn whose body exceeds ``LONG_RESPONSE_CHARS``
    (default 6000) — the v1 STM cap (5000 chars in
    GenyDedupeStrategy) would silently truncate this; v2 must
    preserve it under conversations/.

The snapshot captures everything that downstream parity tests want
to assert about — file presence, content lengths, jsonl line
counts, frontmatter samples — without forcing each test to walk the
filesystem itself.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from service.memory.interaction_event import (
    CounterpartRole,
    Direction,
    Kind,
    canonical_user_id,
    make_event_metadata,
)
from service.memory.manager import SessionMemoryManager


# ─────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────

#: A turn whose assistant body exceeds this length is the "long
#: response" canary. v1 STM truncates at 5000 chars; v2 keeps the
#: full body in conversations/. The fixture writes a body slightly
#: above this so any reasonable variant of the cap (5000 / 5120) is
#: caught.
LONG_RESPONSE_CHARS = 6_000

#: Owner used by ``canonical_user_id``; produces ``owner:scenario``.
SCENARIO_USER = "scenario"

#: Stable ids so downstream snapshot diffs don't churn on uuid.
VTUBER_SESSION_ID = "0000000000000000-vtuber-scenario"
WORKER_SESSION_ID = "0000000000000000-worker-scenario"


# ─────────────────────────────────────────────────────────────────
# Snapshot dataclasses
# ─────────────────────────────────────────────────────────────────


@dataclass
class JsonlLineSummary:
    """One STM jsonl line, normalised for diff-friendly assertions.

    `content_chars` is the *visible* body length on disk; if the
    runtime truncated, this reflects the truncated length, not the
    intended length. Tests that want the intended length compare
    against ``ScenarioInputs``.
    """

    role: str
    kind: Optional[str]
    direction: Optional[str]
    counterpart_id: Optional[str]
    counterpart_role: Optional[str]
    event_id: Optional[str]
    content_chars: int
    has_payload: bool
    extra_metadata_keys: List[str] = field(default_factory=list)


@dataclass
class CategoryInventory:
    """File listing for one ``memory/<category>/`` (or root) folder."""

    category: str
    paths: List[str]  # relative to memory_dir, sorted

    @property
    def count(self) -> int:
        return len(self.paths)


@dataclass
class SessionSnapshot:
    """Per-session state at the end of the scenario."""

    session_id: str
    storage_path: str
    jsonl_lines: List[JsonlLineSummary]
    memory_inventory: Dict[str, CategoryInventory]  # category → inventory

    # Convenience lookups
    @property
    def jsonl_line_count(self) -> int:
        return len(self.jsonl_lines)

    @property
    def total_memory_files(self) -> int:
        return sum(inv.count for inv in self.memory_inventory.values())

    def conversations_files(self) -> List[str]:
        inv = self.memory_inventory.get("conversations")
        return list(inv.paths) if inv else []

    def dms_files(self) -> List[str]:
        inv = self.memory_inventory.get("dms")
        return list(inv.paths) if inv else []


@dataclass
class ScenarioSnapshot:
    vtuber: SessionSnapshot
    worker: SessionSnapshot

    @property
    def all_jsonl_lines(self) -> List[JsonlLineSummary]:
        return [*self.vtuber.jsonl_lines, *self.worker.jsonl_lines]


@dataclass
class ScenarioInputs:
    """The intended (pre-write) content of every recorded turn.

    Downstream parity tests compare the *intended* body length here
    to the *observed* ``JsonlLineSummary.content_chars`` /
    ``conversations/<id>.md`` body length to detect truncation.
    """

    long_turn_intended_chars: int
    user_chat_turns: int
    task_request_turns: int
    tool_run_summary_turns: int
    assistant_turns: int


# ─────────────────────────────────────────────────────────────────
# Scenario driver
# ─────────────────────────────────────────────────────────────────


class MemoryScenarioRunner:
    """Drives the deterministic Memory v2 scenario.

    Usage::

        runner = MemoryScenarioRunner(tmp_path)
        runner.initialize()
        runner.run()
        snapshot = runner.snapshot()

    The runner does *not* assert anything itself — it only returns
    snapshots. Each parity test inspects the snapshot and asserts
    its own invariants (the cross-PR contract is in the
    *assertions*, not the driver).
    """

    def __init__(self, root: Path) -> None:
        self._root = Path(root)
        self._vtuber_path = self._root / VTUBER_SESSION_ID
        self._worker_path = self._root / WORKER_SESSION_ID
        self._vtuber: Optional[SessionMemoryManager] = None
        self._worker: Optional[SessionMemoryManager] = None
        self._inputs = ScenarioInputs(
            long_turn_intended_chars=LONG_RESPONSE_CHARS,
            user_chat_turns=5,
            task_request_turns=3,
            tool_run_summary_turns=3,
            assistant_turns=5,  # one per user_chat
        )

    # ── lifecycle ────────────────────────────────────────────────

    def initialize(self) -> None:
        self._vtuber_path.mkdir(parents=True, exist_ok=True)
        self._worker_path.mkdir(parents=True, exist_ok=True)
        self._vtuber = SessionMemoryManager(str(self._vtuber_path))
        self._vtuber.initialize()
        self._worker = SessionMemoryManager(str(self._worker_path))
        self._worker.initialize()

    @property
    def inputs(self) -> ScenarioInputs:
        return self._inputs

    @property
    def vtuber(self) -> SessionMemoryManager:
        assert self._vtuber is not None, "call initialize() first"
        return self._vtuber

    @property
    def worker(self) -> SessionMemoryManager:
        assert self._worker is not None, "call initialize() first"
        return self._worker

    # ── scenario ─────────────────────────────────────────────────

    def run(self) -> None:
        """Replay the deterministic 5+3+1 turn scenario."""
        self._user_chat_turn(
            user_text="안녕! 워커한테 test.txt 만들어달라고 해줄래?",
            assistant_text="알겠어요! 워커한테 바로 부탁해볼게요.",
        )
        self._paired_task_pair(
            request_body=(
                "[DM to worker (internal)]: test.txt 파일을 만들고, 그 안에 "
                "너(Sub-Worker)의 자기소개를 작성해줘."
            ),
            result_body=(
                "[SUB_WORKER_RESULT]\nstatus: ok\n"
                "summary: Completed using Write (1 tool call).\n"
                "details: Tools used: Write\nartifacts:\n"
                f"  - /tmp/{WORKER_SESSION_ID}/test.txt"
            ),
            tools_used=["Write"],
            files_written=[f"/tmp/{WORKER_SESSION_ID}/test.txt"],
        )
        self._user_chat_turn(
            user_text="좋아 결과 보여줘",
            assistant_text="워커가 만든 test.txt 안에 자기소개를 적어뒀어요.",
        )
        self._user_chat_turn(
            user_text="이번엔 보고서 형태로 길게 써달라고 해.",
            assistant_text="네! 길게 써달라고 다시 부탁할게요.",
        )
        self._paired_task_pair(
            request_body=(
                "[DM to worker (internal)]: 위 자기소개를 더 자세하고 길게 "
                "리포트 형식으로 작성해줘 (5000자 이상)."
            ),
            result_body=self._long_assistant_body(),
            tools_used=["Write", "Read"],
            files_written=[f"/tmp/{WORKER_SESSION_ID}/intro_report.md"],
        )
        self._user_chat_turn(
            user_text="좋다, 다음 작업도 부탁해.",
            assistant_text="물론이에요! 다음 task 도 워커에게 넘길게요.",
        )
        self._paired_task_pair(
            request_body="[DM to worker (internal)]: 그 보고서 끝에 요약 한 줄 추가해줘.",
            result_body=(
                "[SUB_WORKER_RESULT]\nstatus: ok\n"
                "summary: Appended summary line.\n"
            ),
            tools_used=["Edit"],
            files_written=[f"/tmp/{WORKER_SESSION_ID}/intro_report.md"],
        )
        self._user_chat_turn(
            user_text="고마워! 이상이야.",
            assistant_text="네, 고생하셨어요. 또 부탁할 일 있으면 말씀해 주세요!",
        )

    # ── snapshot ─────────────────────────────────────────────────

    def snapshot(self) -> ScenarioSnapshot:
        return ScenarioSnapshot(
            vtuber=self._snapshot_session(VTUBER_SESSION_ID, self._vtuber_path),
            worker=self._snapshot_session(WORKER_SESSION_ID, self._worker_path),
        )

    # ─────────────────────────────────────────────────────────────
    # Internal: turn helpers
    # ─────────────────────────────────────────────────────────────

    def _user_chat_turn(self, *, user_text: str, assistant_text: str) -> None:
        """One user↔VTuber exchange; recorded only on the vtuber STM."""
        # User → VTuber (in)
        self.vtuber.record_message(
            "user",
            user_text,
            metadata=make_event_metadata(
                kind=Kind.USER_CHAT,
                direction=Direction.IN,
                counterpart_id=canonical_user_id(SCENARIO_USER),
                counterpart_role=CounterpartRole.USER,
            ),
        )
        # VTuber → User (out)
        self.vtuber.record_message(
            "assistant",
            assistant_text,
            metadata=make_event_metadata(
                kind=Kind.USER_CHAT,
                direction=Direction.OUT,
                counterpart_id=canonical_user_id(SCENARIO_USER),
                counterpart_role=CounterpartRole.USER,
            ),
        )

    def _paired_task_pair(
        self,
        *,
        request_body: str,
        result_body: str,
        tools_used: List[str],
        files_written: List[str],
    ) -> None:
        """One VTuber→Sub-Worker task_request and the resulting
        tool_run_summary, recorded on both STMs (mirror direction).

        The pairing follows cycle 20260430_2 invariants:
          * VTuber records the request as direction=out,
            counterpart_role=paired_subworker.
          * Sub-Worker records the same request as direction=in,
            counterpart_role=paired_vtuber.
          * The subsequent SUB_WORKER_RESULT is symmetric.
        """
        # ── task_request (VTuber side, out) ─────────────────────
        req_meta_v = make_event_metadata(
            kind=Kind.TASK_REQUEST,
            direction=Direction.OUT,
            counterpart_id=WORKER_SESSION_ID,
            counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
        )
        self.vtuber.record_message("assistant_dm", request_body, metadata=req_meta_v)

        # ── task_request (Sub-Worker side, in) ──────────────────
        req_meta_w = make_event_metadata(
            kind=Kind.TASK_REQUEST,
            direction=Direction.IN,
            counterpart_id=VTUBER_SESSION_ID,
            counterpart_role=CounterpartRole.PAIRED_VTUBER,
        )
        self.worker.record_message("assistant_dm", request_body, metadata=req_meta_w)

        # ── tool_run_summary (Sub-Worker reports back; recorded
        #    on VTuber STM as direction=in / kind=tool_run_summary) ─
        payload = {
            "status": "ok",
            "tools_used": tools_used,
            "files_written": files_written,
            "files_read": [],
            "bash_commands": [],
            "web_fetches": [],
            "errors": [],
            "total_calls": len(tools_used),
            "ok_calls": len(tools_used),
            "failed_calls": 0,
            "duration_ms": 1234,
            "cost_usd": 0.012,
        }
        result_meta_v = make_event_metadata(
            kind=Kind.TOOL_RUN_SUMMARY,
            direction=Direction.IN,
            counterpart_id=WORKER_SESSION_ID,
            counterpart_role=CounterpartRole.PAIRED_SUBWORKER,
            linked_event_id=req_meta_v["event_id"],
            payload=payload,
        )
        self.vtuber.record_message("user", result_body, metadata=result_meta_v)

        # Worker side records the same result as out
        result_meta_w = make_event_metadata(
            kind=Kind.TASK_RESULT,
            direction=Direction.OUT,
            counterpart_id=VTUBER_SESSION_ID,
            counterpart_role=CounterpartRole.PAIRED_VTUBER,
            linked_event_id=req_meta_w["event_id"],
            payload=payload,
        )
        self.worker.record_message("assistant", result_body, metadata=result_meta_w)

    def _long_assistant_body(self) -> str:
        """Build a deterministic >LONG_RESPONSE_CHARS body.

        Repeated paragraph so the body has *internal structure* (not
        just a flat blob) — easier to spot mid-truncation.
        """
        para = (
            "I am a Sub-Worker focused on completing tasks. I read context "
            "files, write code, edit existing files, and report back to "
            "my paired VTuber with structured tool_run_summaries. "
        )
        out = ["[SUB_WORKER_RESULT]", "status: ok",
               "summary: Generated long self-introduction report.", "details: |"]
        while sum(len(s) for s in out) < LONG_RESPONSE_CHARS:
            out.append(para)
        return "\n".join(out)

    # ─────────────────────────────────────────────────────────────
    # Internal: snapshot helpers
    # ─────────────────────────────────────────────────────────────

    def _snapshot_session(self, session_id: str, storage_path: Path) -> SessionSnapshot:
        return SessionSnapshot(
            session_id=session_id,
            storage_path=str(storage_path),
            jsonl_lines=self._read_jsonl(storage_path / "transcripts" / "session.jsonl"),
            memory_inventory=self._scan_memory(storage_path / "memory"),
        )

    @staticmethod
    def _read_jsonl(path: Path) -> List[JsonlLineSummary]:
        if not path.exists():
            return []
        out: List[JsonlLineSummary] = []
        for raw in path.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                # Corrupted line — record as an unknown so tests can
                # detect concurrency damage (Phase 1 PR 3 STM lock).
                out.append(JsonlLineSummary(
                    role="<corrupt>", kind=None, direction=None,
                    counterpart_id=None, counterpart_role=None,
                    event_id=None, content_chars=len(raw), has_payload=False,
                ))
                continue
            meta = rec.get("metadata") or {}
            content = rec.get("content")
            content_chars = len(content) if isinstance(content, str) else 0
            extra = sorted(
                k for k in meta.keys()
                if k not in {"event_id", "kind", "direction",
                             "counterpart_id", "counterpart_role",
                             "linked_event_id", "payload"}
            )
            out.append(JsonlLineSummary(
                role=str(rec.get("role", "")),
                kind=meta.get("kind"),
                direction=meta.get("direction"),
                counterpart_id=meta.get("counterpart_id"),
                counterpart_role=meta.get("counterpart_role"),
                event_id=meta.get("event_id"),
                content_chars=content_chars,
                has_payload=bool(meta.get("payload")),
                extra_metadata_keys=extra,
            ))
        return out

    @staticmethod
    def _scan_memory(memory_dir: Path) -> Dict[str, CategoryInventory]:
        """Return ``category → CategoryInventory`` for every md file
        under ``memory_dir``. ``root`` collects files directly under
        ``memory/`` (e.g. MEMORY.md, YYYY-MM-DD.md). Reserved files
        like ``_index.json`` / ``_vault_map.json`` / ``summary.md``
        are excluded.
        """
        out: Dict[str, List[str]] = {}
        if not memory_dir.exists():
            return {}
        reserved = {"_index.json", "_vault_map.json", "summary.md"}
        for p in sorted(memory_dir.rglob("*")):
            if not p.is_file():
                continue
            if p.name in reserved or p.name.startswith("."):
                continue
            if p.suffix != ".md":
                continue
            rel = p.relative_to(memory_dir)
            parts = rel.parts
            if len(parts) == 1:
                category = "root"
            else:
                category = parts[0]
            out.setdefault(category, []).append(rel.as_posix())
        return {
            cat: CategoryInventory(category=cat, paths=sorted(paths))
            for cat, paths in out.items()
        }


# ─────────────────────────────────────────────────────────────────
# Convenience: pytest fixture-style entry point
# ─────────────────────────────────────────────────────────────────


def run_scenario(root: Path) -> Tuple[MemoryScenarioRunner, ScenarioSnapshot]:
    """One-shot runner used by tests that don't need to inspect the
    scenario mid-flight. Returns ``(runner, snapshot)`` so the caller
    keeps access to the underlying managers if it needs to make
    extra assertions (e.g. invoking a tool against the vault).
    """
    runner = MemoryScenarioRunner(root)
    runner.initialize()
    runner.run()
    return runner, runner.snapshot()


__all__ = [
    "LONG_RESPONSE_CHARS",
    "SCENARIO_USER",
    "VTUBER_SESSION_ID",
    "WORKER_SESSION_ID",
    "CategoryInventory",
    "JsonlLineSummary",
    "MemoryScenarioRunner",
    "ScenarioInputs",
    "ScenarioSnapshot",
    "SessionSnapshot",
    "run_scenario",
]
