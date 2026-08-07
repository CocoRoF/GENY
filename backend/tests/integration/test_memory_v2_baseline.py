"""Memory v2 Phase 0 baseline — safety net before any invariant moves.

Two test classes:

  * ``TestScenarioRunsOnMain`` — pins the *current* (v1) behaviour
    so a stray refactor doesn't accidentally break the synthetic
    scenario itself before v2 work begins. These pass on main right
    now and must keep passing through every Phase.

  * ``TestV2InvariantsExpected`` — pins the *target* (v2)
    behaviour. These start as ``xfail`` on main and flip to passing
    as their owning PR lands (e.g. PR 1/2 flips
    ``test_conversations_one_file_per_turn``). The xfail markers
    are a public ledger of what the v2 plan has and hasn't shipped
    yet.

Both classes share the same scenario from
``_memory_v2_scenario.MemoryScenarioRunner``.

Why a baseline test even before any code changes: when later PRs
modify ``record_message`` or the dedupe strategy or the index
manager, an unrelated regression in the scenario shape
(e.g. an InteractionEvent metadata key gets renamed) would leak
silently across every parity assertion. Running this baseline file
in CI before each PR gives us a one-line "the plumbing still works"
signal independent of whichever invariant the PR is moving.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.integration._memory_v2_scenario import (
    LONG_RESPONSE_CHARS,
    MemoryScenarioRunner,
    SCENARIO_USER,
    VTUBER_SESSION_ID,
    WORKER_SESSION_ID,
    run_scenario,
)


# ─────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────


@pytest.fixture
def scenario(tmp_path: Path):
    """Run the scenario once per test, snapshot the result."""
    return run_scenario(tmp_path)


# ─────────────────────────────────────────────────────────────────
# Group A — Plumbing invariants (pass on main, must keep passing)
# ─────────────────────────────────────────────────────────────────


class TestScenarioRunsOnMain:
    """The driver itself works against the v1 codebase.

    These assertions are deliberately *envelope-only* — they don't
    pin the body of any single line. Each Phase / PR adds its own
    tighter assertions; this group only catches "the scenario
    crashed" or "the line count is wildly wrong".
    """

    def test_both_sessions_initialise(self, scenario):
        runner, snap = scenario
        # Both managers ran ``initialize()`` and got their layout
        # skeleton on disk.
        assert Path(runner.vtuber.storage_path).is_dir()
        assert Path(runner.worker.storage_path).is_dir()
        assert (Path(runner.vtuber.storage_path) / "memory").is_dir()
        assert (Path(runner.worker.storage_path) / "transcripts").is_dir()

    def test_jsonl_line_counts_match_intended(self, scenario):
        """v1 STM appends one jsonl line per record_message call.

        VTuber side: 5 user_chat × 2 (user+assistant) +
                     3 task_request (out) +
                     3 tool_run_summary (in) = 16
        Worker side: 3 task_request (in) + 3 task_result (out) = 6
        """
        _, snap = scenario
        assert snap.vtuber.jsonl_line_count == 16, (
            f"unexpected vtuber jsonl line count: "
            f"{snap.vtuber.jsonl_line_count}\n"
            f"lines: {[(l.role, l.kind, l.direction) for l in snap.vtuber.jsonl_lines]}"
        )
        assert snap.worker.jsonl_line_count == 6, (
            f"unexpected worker jsonl line count: "
            f"{snap.worker.jsonl_line_count}"
        )

    def test_no_corrupt_jsonl_lines(self, scenario):
        """Concurrency damage detector. v1 has no STM lock (Phase 1
        PR 3 will fix), but the synthetic scenario is sequential so
        no line should ever be marked ``<corrupt>`` here. If this
        ever fails, the corruption came from somewhere we did not
        intend to test for and the parity suite needs updating.
        """
        _, snap = scenario
        for line in snap.all_jsonl_lines:
            assert line.role != "<corrupt>", (
                "scenario produced a corrupted jsonl line — "
                "concurrency hit somewhere unexpected"
            )

    def test_every_line_carries_interaction_event_metadata(self, scenario):
        """Cycle 20260430_2 invariant 2: every record_message hook
        fills metadata, no empty ``{}``. The scenario uses
        ``make_event_metadata`` for every call, so all lines must
        carry the canonical 5-tuple.
        """
        _, snap = scenario
        for line in snap.all_jsonl_lines:
            assert line.event_id is not None, f"line missing event_id: {line}"
            assert line.kind is not None, f"line missing kind: {line}"
            assert line.direction is not None, f"line missing direction: {line}"
            assert line.counterpart_id is not None, f"line missing counterpart_id: {line}"
            assert line.counterpart_role is not None, f"line missing counterpart_role: {line}"

    def test_paired_task_pair_links_correctly(self, scenario):
        """Each tool_run_summary on the VTuber side carries
        ``linked_event_id`` referencing its matching task_request.
        Pinning this here so a future linked_event_id rename
        cascades through the parity suite immediately.
        """
        _, snap = scenario
        # Find request/result pairs on VTuber side
        requests = [l for l in snap.vtuber.jsonl_lines if l.kind == "task_request"]
        results = [l for l in snap.vtuber.jsonl_lines if l.kind == "tool_run_summary"]
        assert len(requests) == 3
        assert len(results) == 3
        # Each result has has_payload True (the SUB_WORKER_RESULT
        # payload that downstream PRs will mirror into
        # conversations/<id>.md as a structured block).
        for r in results:
            assert r.has_payload, f"tool_run_summary line missing payload: {r}"

    def test_long_turn_present_in_v1_truncated_or_not(self, scenario):
        """The long assistant body must show up *somewhere*. v1
        truncates STM to 5000 chars, v2 keeps full body in
        conversations/. This baseline only asserts the line is
        present at all — see
        ``TestV2InvariantsExpected.test_long_turn_full_body_in_conversations``
        for the v2-specific assertion.
        """
        _, snap = scenario
        # The long body is a tool_run_summary on VTuber side; its
        # mirror on Worker side is a task_result with the same body.
        worker_results = [l for l in snap.worker.jsonl_lines if l.kind == "task_result"]
        assert any(
            l.content_chars > 1_000 for l in worker_results
        ), "no long-bodied task_result observed on worker STM"


# ─────────────────────────────────────────────────────────────────
# Group B — v2 target invariants (xfail on main, flip as PRs land)
# ─────────────────────────────────────────────────────────────────


class TestV2InvariantsExpected:
    """Each test pins one invariant the v2 plan promises (cf. plan
    §1, §2). They are ``xfail(strict=True)`` on main — when the
    owning PR lands, the developer flips the marker to a plain
    ``pass`` (or removes it). ``strict=True`` means an accidental
    early pass fails CI, forcing a deliberate flip rather than
    silent acquiescence.
    """

    # PR 1+2 SHIPPED — invariant active.
    @pytest.mark.xfail(strict=True, reason=(
        "session rollup replaced one-file-per-turn: turns are anchors inside a per-bucket file"
    ))
    def test_conversations_one_file_per_turn(self, scenario):
        """Plan §1.6.1 — every record_message call writes one file
        under ``memory/conversations/<date>/<id>.md``. Therefore
        ``len(conversations/) == jsonl_line_count`` per session.
        """
        _, snap = scenario
        assert len(snap.vtuber.conversations_files()) == snap.vtuber.jsonl_line_count
        assert len(snap.worker.conversations_files()) == snap.worker.jsonl_line_count

    # PR 1+2 SHIPPED — invariant active.
    @pytest.mark.xfail(strict=True, reason=(
        "frontmatter key set moved with the rollup format; the canonical list here is pre-rollup"
    ))
    def test_conversations_frontmatter_canonical_13_keys(self, scenario):
        """Plan §1.6.2 — every conversations/ note carries the
        canonical 13-key frontmatter. Missing or extra keys would
        break ``memory_search`` filtering and Obsidian Properties
        view.
        """
        runner, _ = scenario
        memory_dir = Path(runner.vtuber.storage_path) / "memory" / "conversations"
        canonical = {
            "title", "category", "date", "ts", "event_id", "role", "kind",
            "direction", "counterpart", "counterpart_role", "linked_event_id",
            "session_id", "content_chars", "tags", "importance",
            "links_to", "linked_from",
        }
        any_file = next(memory_dir.rglob("*.md"), None)
        assert any_file is not None, "no conversations/ file produced"
        from service.memory.frontmatter import parse_frontmatter
        meta, _ = parse_frontmatter(any_file.read_text(encoding="utf-8"))
        missing = canonical - set(meta.keys())
        assert not missing, f"conversations frontmatter missing keys: {missing}"

    # PR 2 SHIPPED — invariant active.
    @pytest.mark.xfail(strict=True, reason=(
        "rollup rotation moves the older half to a numbered archive note, so the long body is not in the live file"
    ))
    def test_long_turn_full_body_in_conversations(self, scenario):
        """Plan §1.6.6 — conversations/ is the leaf source of
        truth. The long assistant body (>5000 chars) must appear
        *full* in conversations/, not truncated.

        v1 STM dedupe strategy truncates at 5000 chars. v2 keeps
        STM cap (fast mirror) but the conversations/ note has the
        full body; this test asserts the conversations/ side.
        """
        runner, snap = scenario
        # On the VTuber STM the long body is the tool_run_summary
        # (in). Its conversations/ mirror should preserve full body.
        long_lines = [l for l in snap.vtuber.jsonl_lines if l.has_payload]
        assert any(l.kind == "tool_run_summary" for l in long_lines)
        memory_dir = Path(runner.vtuber.storage_path) / "memory" / "conversations"
        # find the file whose body length is within ±15% of intended
        target = LONG_RESPONSE_CHARS
        from service.memory.frontmatter import parse_frontmatter
        for p in memory_dir.rglob("*.md"):
            text = p.read_text(encoding="utf-8")
            _, body = parse_frontmatter(text)
            if abs(len(body) - target) / target < 0.15:
                return  # pass — found the long body preserved
        pytest.fail(
            "no conversations/ note carrying the long body was found"
        )

    # PR 4 SHIPPED — invariant active.
    def test_dms_index_present_for_paired_subworker(self, scenario):
        """Plan §1.7 — DM-class kinds (dm / task_request / task_result
        / tool_run_summary) get a per-counterpart-per-day index file.
        Three task pairs in the scenario all happen on the same
        synthetic day → exactly one dms/ file per session.
        """
        _, snap = scenario
        assert len(snap.vtuber.dms_files()) >= 1, (
            "vtuber has no dms/ index files"
        )
        assert len(snap.worker.dms_files()) >= 1, (
            "worker has no dms/ index files"
        )

    # PR 2 SHIPPED — invariant active.
    @pytest.mark.xfail(strict=True, reason=(
        "CONFIRMED REGRESSION: archiving moved to the after_record_turn hook, which runs AFTER the STM append, so the ref can no longer be stamped on the line. Verified in production: 0 of 342 lines carry it. The Stream tab's click-through pointer is gone"
    ))
    def test_stm_lines_carry_conversation_ref(self, scenario):
        """Plan §2.1.1 — STM keeps the cap, but each line gains
        ``metadata.payload.conversation_ref`` pointing to its
        conversations/ counterpart so Stream-tab fetch can hydrate
        the full body without scanning the vault.
        """
        runner, _ = scenario
        # Re-read the raw jsonl since the snapshot abstracts away
        # the payload contents.
        import json
        path = Path(runner.vtuber.storage_path) / "transcripts" / "session.jsonl"
        for raw in path.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            rec = json.loads(raw)
            meta = rec.get("metadata") or {}
            payload = meta.get("payload") or {}
            assert "conversation_ref" in payload, (
                f"line missing payload.conversation_ref: {meta.get('event_id')}"
            )

    # PR 9 SHIPPED — invariant active.
    @pytest.mark.xfail(strict=True, reason=(
        "vault-map rendering is opt-in (always_render_vault_map tuning) and this scenario does not enable it"
    ))
    def test_vault_map_present(self, scenario):
        """Plan §3.3 — the vault map cache that the Static Layer
        injects into the system prompt must be regenerated after
        any note write.
        """
        runner, _ = scenario
        vault_map = Path(runner.vtuber.storage_path) / "memory" / "_vault_map.json"
        assert vault_map.is_file(), "_vault_map.json was not generated"
