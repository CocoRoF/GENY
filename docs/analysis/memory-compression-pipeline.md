# Memory Compression Pipeline — Design + Implementation Plan

Status: **DESIGN / FOR REVIEW** (2026-06-22). No code changed yet.

## 1. Goal & philosophy

Memory must work as:

1. **원본 보관, 필요시 탐색** — keep raw originals on disk; explore on demand.
2. **압축본 선행 제공** — serve a *semantic* compressed view first (not raw).
3. **Progressive disclosure** — the compressed view is *layered*, so the agent
   (and the human in Opsidian) can drill stepwise: map → digest → segment → raw.

## 2. Why it doesn't work today (recap, evidence-backed)

The injection *machinery* is wired (Stage-2 `MemoryAwareRetriever` is budget-capped
at `max_inject_chars=10000`, has `slim_mode`, `always_render_vault_map=True`, and the
agent has drill tools). **But the compressed layer it serves is hollow:**

- **L2 evergreen `MEMORY.md` is never written** (prod: `ABSENT`). Geny uses
  `conversation_archiver` (raw `<!--meta-->` append) + Notes, never `LTMHandle`.
- **L1 "summary" is a mechanical transcript list, not a semantic digest**
  ([manager.py:2456](../../backend/service/memory/manager.py) "Session End Summary" →
  "Conversation Flow: 1.[17:07]… 2.[17:08]…"). 65,046,456 raw chars → a 3.6 KB *list of
  turn openers*, labelled "End" while the session runs 54h+.
- **compactions are empty** (prod: the `.md` has no body).
- **No compression hierarchy** → progressive disclosure has no levels to step through.
  Reality: raw piles (`__reflection.md` 432 KB, daily 584 files, observations 951
  files / 60 MB) + one flat index (`daily/_index.json` 463 KB) + one mechanical summary.
  `vault_map` points at hundreds of *raw* notes, not a compressed map.

Net: raw is **not** dumped into context (it's capped), but the "compressed-first"
slot is filled with a thin transcript index over ever-growing raw — so neither
*압축본 선행* nor *단계적 탐색* is actually realized.

## 3. Design — the Memory Pyramid

Five tiers. Each higher tier is a *semantic compression* of the one below, produced
by an LLM summarizer, and is the thing served first.

```
 L4  MAP        compressed navigable index  ── always injected (small)
 L3  EVERGREEN  MEMORY.md: durable identity/knowledge ── always injected
 L2  ROLLUPS    daily digest + topic digest ── injected by relevance, drillable
 L1  SEGMENT    rolling session digest (last window) ── always injected (recent gist)
 L0  RAW        turns / reflections / observations / executions ── kept, drill-only
```

- **L0 Raw (kept):** unchanged originals on disk. Explorable via tools. (Add
  retention/rotation later — separate P0 in the storage report.)
- **L1 Segment digest (rolling):** every window of N raw turns (or on idle) is
  compressed into a short semantic digest — *what happened, decisions, facts learned,
  open threads*. This **replaces the mechanical transcript summary**. Always injected
  (the "recent gist"). Stored as the STM summary the retriever's L1 already reads.
- **L2 Rollups (daily + topic):** L1 segment digests roll up into a per-day digest
  (`daily digest`) and per-topic evergreen notes (`topic digest`). Injected by
  relevance + drillable from the map. Stored in **LTMHandle** dated/topic files
  (currently unused — exactly the empty machinery we fill).
- **L3 Evergreen `MEMORY.md`:** the durable compressed core (identity, stable facts,
  long-running threads), rolled up from L2. **Always injected** (retriever L2 already
  reads it). Slowly updated.
- **L4 Map:** `IndexHandle.render_vault_map` upgraded to render the *compressed
  hierarchy* — "here are the topics/days that exist, 1-line digest each, and how to
  drill in" — instead of a flat list of raw notes. Always injected (small).

### 3.1 Compression engine (the missing piece) — LOCKED DESIGN

A **MemoryCompactor** that turns lower tiers into higher ones via a **proper,
preservation-focused LLM summarization pass** (cost is not a constraint — use a
capable model and multi-pass extraction; never a cheap one-liner). It reuses /
extends the executor's existing machinery rather than duplicating it.

**What already exists (reuse):**
- *Context-pressure compaction* is REAL: Stage-2 proactive (`>80%` window,
  s02_context stage.py:236) + Stage-4 `TokenBudgetGuard` (`action="compact"`,
  guards.py:74) → `core/compaction.py:run_compaction()` trims `state.messages` and
  persists a snapshot via `record_compaction()` → `compactions/` category. **But the
  wired compactor is a placeholder** (static `SummaryCompactor`), which is why prod
  `compactions/` is empty. → We wire a strong `LLMSummaryCompactor` with a
  preservation prompt.
- `LLMSummaryCompactor` (s02/compactors.py:135) shows the model-call seam to reuse.
- Stage-19 `Summarizer` strategy + session-close `write_summary()` → `transcripts/
  summary.md` (read by retriever L1). Default is `NoSummarizer` (no-op); Geny's
  mechanical "Session End Summary" fills the gap with a transcript list.
- `LTMHandle.append`/`write_dated`/`write_topic` + `read_main` (MEMORY.md) — present
  but only `record_execution()` ever writes (dated Q&A); **MEMORY.md never written**.

**Triggers — DECISION (NOT turn-count):**
1. **Context-pressure (reactive):** when the projected next-call context would
   exceed the model window → compact NOW. Reuse Stage-2/Stage-4 + `run_compaction`,
   but with a **strong LLM compactor + preservation**. Keeps the live context valid.
2. **Idle (proactive, primary cadence):** when the session goes idle (Geny's
   idle/thinking-trigger detector), run the **tiered semantic rollup** — there's spare
   time, so do the thorough job. This is a host-driven call into an executor
   `MemoryCompactor.run(level)`; the pipeline never does network on build.
3. **Lazy (size-driven):** large existing/raw data is compacted **on access / as idle
   gradually works the backlog** — not eagerly. A tier is materialized when first
   needed or when idle reaches it.

**Rollup API (new `MemoryCompactor`, executor):**
- `summarize_segment(window) -> L1 rolling digest` — replaces the mechanical summary;
  becomes what `read_summary` returns.
- `rollup_day(date) -> L2 daily digest`; `rollup_topics() -> L2 topic digests`.
- `rollup_evergreen() -> L3 MEMORY.md` (fills the empty evergreen via `LTMHandle`).
- `render_map() -> L4 compressed map` (upgrades `IndexHandle.render_vault_map`).

**Proper summarization (quality bar):** structured, multi-pass; the prompt MUST
preserve, verbatim where needed: facts, decisions, named entities, user preferences/
commitments, open threads/TODOs, and (for VTuber) relationship/affect state. Output is
sectioned (so it's drillable), not prose-only.

### 3.2 Injection model (compressed-first)

Stage-2 serves, within the budget: **L4 map + L3 evergreen + L1 latest segment +
pinned critical + a small L0 recent tail**. L2 rollups injected by relevance
(vector/keyword) — but as *digests*, not raw. Raw (L0) is NOT injected; it is reached
only by drill tools. Budget split favours compressed tiers (map/evergreen/segment),
with a small recent-raw tail for immediacy.

### 3.3 Progressive disclosure (drill-down)

The agent receives the **map + compressed tiers**, then narrows stepwise via tools:

```
map (L4)  →  open a day/topic digest (L2)  →  open a segment digest (L1)  →  open raw turns (L0)
```

Mostly reuses existing read tools (`opsidian_read`, `memory_read`, `memory_search`)
but pointed at the **digest hierarchy** (which is now searchable/navigable), plus a
thin `memory_open(ref, depth)` convenience that drills one level. Each step narrows
scope, so the agent pulls raw only for the specific thing it needs.

## 4. Where it lives (extend-executor, Geny consumes)

Per the standing principle ([[feedback_extend_executor_not_adapter_layer]]):

- **geny-executor (generalize):** the `MemoryCompactor` rollup engine + the tier
  contracts; write digests into the existing `LTMHandle` (MEMORY.md / dated / topics);
  upgrade `IndexHandle.render_vault_map` to the compressed map; make `read_summary`
  return the semantic rolling digest; expose the drill primitive. The executor already
  has LTM, IndexHandle, the retriever tiers, the summarizer sub-agent, and budget
  compaction — this *fills and connects* them.
- **Geny (consume):** wire the compactor triggers (turn-count / idle / day-change);
  replace the mechanical "Session End Summary" with the semantic rolling digest; feed
  the digest hierarchy to Opsidian; configure `MemoryHooks` budget split for
  compressed-first. Keep `conversation_archiver` raw as L0 (the compactor compresses
  it — don't dump it into context).
- **Opsidian (view):** mirror the agent's experience for the human — default to
  evergreen + latest digest + compressed map, drill into day → segment → raw; parse
  `<!--meta-->` blocks; virtualize large files.

## 5. Implementation plan (phased PRs — approve per phase)

**Phase 1 — executor: compaction engine + tier plumbing** (geny-executor minor)
- `MemoryCompactor` (new `memory/compaction/…`): segment/day/evergreen rollups via an
  injected `summarizer` callable; idempotent + best-effort; `transport`/summarizer hook
  for tests.
- `LTMHandle` digest writers used for L2/L3 (MEMORY.md + dated + topics).
- `read_summary` → semantic rolling digest (L1).
- `IndexHandle.render_vault_map` → compressed hierarchical map (L4).
- Drill primitive for L4→L0 navigation.
- Tests + version bump + publish.

**Phase 2 — Geny: wire triggers + replace mechanical summary + injection split**
- Trigger the compactor (Stage 18/19 or a background job): N-turn segment, day rollup,
  evergreen rollup.
- Replace `manager.py` "Session End Summary" with the executor rolling digest.
- Write `MEMORY.md` via LTM (fill the empty L3).
- Configure `MemoryHooks` for compressed-first budget; verify Stage-2 injects
  digests + map, not raw.
- Pin executor floor.

**Phase 3 — raw retention (ties to the storage report's P0)**
- Rotate/compress `__reflection.md` + conversation files past a size/turn cap (compactor
  produces the digest, then archives the raw segment).
- Observation TTL / daily rotation / low-importance GC.

**Phase 4 — Opsidian viewer: compressed-first + drill-down**
- Default compressed view (evergreen + latest digest + map) → drill to raw.
- Parse `<!--meta-->`; virtualize large files; light refresh.

**Phase 5 — validation**
- Metrics: injected compressed-char ratio (should be ~all compressed + small raw tail),
  drill-tool usage, raw growth bounded, retrieval latency on a 200 MB session.

## 6. Decisions — RESOLVED (2026-06-22)

1. **Cadence/trigger:** ❌ NOT every-N-turns. ✅ **idle-triggered (primary)** +
   ✅ **context-pressure (reactive, when the context won't fit the model)**. Summaries
   are **thorough/proper**, never lightweight.
2. **Preservation:** important info is **always preserved** — pinned/critical notes are
   never compacted away (already always-injected at retriever L1.5), and the
   summarization prompt explicitly preserves facts / decisions / entities / user
   preferences + commitments / open threads / relationship+affect state. High-importance
   survives rollup near-verbatim.
3–4. **Quality over cost:** implementation cost is **not** a constraint — use a capable
   model, multi-pass extraction, and the most rational/ideal design (no shortcuts for
   the sake of cheapness).
5. **Large data:** **lazy compaction** by default — big raw / existing 200 MB sessions
   are compacted on access or as idle gradually works the backlog, not eagerly.

**Still open (implementation-level, not blocking the design):**
- Format: keep `conversation_archiver` raw as L0 (compress via the engine) — recommended.
- Idle-trigger ownership: Geny's idle/thinking-trigger detector calls
  `MemoryCompactor.run()` (a long-idle VTuber may not take turns for hours, so the
  Stage-18/19 in-pipeline path can't be the only trigger).

## 6b. Preservation guarantees (always-keep)

- **Pinned/critical** (`pin_category`, default `critical`) — never compacted, always
  injected.
- The proper-summary prompt preserves: **facts, decisions, named entities, user
  preferences & commitments, open threads/TODOs, relationship/affect state**.
- Raw is **never deleted by compaction** — only rotated/archived after a digest exists
  (Phase 3), and always reachable via drill-down. Compaction is loss-tolerant *because*
  raw is kept + drillable.

## 6c. Progress log

- **2026-06-22 — Phase 1a DONE (geny-executor 2.16.0, published):** `MemoryRollup`
  (`geny_executor.memory.rollup`) — the L1 **rolling digest**: folds prior digest +
  recent raw STM turns into a preservation-focused semantic digest via a host-injected
  LLM callable, persisted to `write_summary` (retriever L1, always injected). Owns the
  PRESERVE clause. Best-effort, host-driven (idle/pressure/lazy). +5 tests green.
  *Not yet wired into Geny — no prod effect until Phase 2.*

- **2026-06-22 — Phase 2 DONE + VERIFIED (prod):** `SessionMemoryManager.compact_now()`
  wires `MemoryRollup` + `build_memory_llm`; idle trigger in `thinking_trigger.scan_all`
  (throttled ≥600s); `auto_flush` (session-close) now writes the semantic digest to the
  L1 slot (mechanical text still archived to executions LTM). Required geny-executor
  **2.17.0** (fixed: non-streaming claude_code `create_message` delivered NO prompt →
  only streaming sessions worked; now appends the flattened prompt as the positional
  arg). Live test on session 18da9654: 65M raw chars → 2,886-char sectioned digest
  (## Summary / ## Facts & Decisions / ## Entities) preserving user title, names,
  decisions. ✅
  - **Env wart:** `/root/.claude.json` intermittently disappears on the host (the CLI
    rotates it); a flapped compaction is skipped (best-effort) and retried next idle.
    Consider stabilizing the CLI config / rolling the CLI forward to 2.1.185.

- **2026-06-22 — L3 EVERGREEN DONE + VERIFIED (executor 2.18.0 + Geny):**
  `MemoryRollup.rollup_evergreen` maintains a rewritable pinned `critical` evergreen
  note (always-injected L1.5, never compacted); `compact_now(evergreen=)` wires it;
  idle merges it on a slower ≥1800s cadence; session-close runs a full rollup. Live
  test (session 18da9654): `segment_written + evergreen_written`; evergreen preserved
  identity (엘렌), nickname (사장님), a durable Skyrim fact, recent game context. ✅
  Both compressed-first tiers (L1 recent + L3 durable) now maintained + always injected.

### Remaining
- **Phase 1b leftover (executor/Geny):** L2 daily/topic rollups + L4 compressed
  `render_vault_map` + swap the in-context (Stage 2/4) placeholder compactor for the
  strong LLM compactor (context-pressure path).
- **Phase 2 (Geny):** wire the host LLM `summarize` callable + trigger `MemoryRollup.run()`
  from the idle/thinking-trigger detector; replace `manager.py` mechanical "Session End
  Summary"; configure `MemoryHooks` compressed-first budget. ← first visible prod effect.
- **Phase 3:** raw retention/rotation (reflection rotation, observation TTL/GC).
- **Phase 4:** Opsidian compressed-first view + drill-down + `<!--meta-->` parse + virtualize.

## 7. Success criteria

- Stage-2 injection is **compressed-first**: map + evergreen + rolling digest + pinned
  + small raw tail — measurably mostly-compressed, within budget.
- `MEMORY.md` is maintained (non-empty, semantic).
- The agent **drills** (map → digest → raw) instead of receiving raw piles.
- Raw growth is **bounded** (rotation/TTL); Opsidian renders fast.
- The human sees compressed-first + drill-down in Opsidian.
