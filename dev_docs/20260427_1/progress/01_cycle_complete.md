# Cycle 20260427_1 — Library (NEW) — close-out

**Date:** 2026-04-27
**Status:** ✅ All 6 PRs merged. End-to-end create flow live.

## Summary of shipped work

| PR | Title | Files |
|----|------|-------|
| #456 | PR-A scaffold + draft store + generic editor | backend create patch, frontend tab + store + canvas wiring |
| #457 | PR-B Stage 6 (api) + Stage 18 (memory) curated | 2 stage editors w/ ModelConfigEditor, strategy tile pickers |
| #458 | PR-C Stage 10 (tools) + ToolCheckboxGrid | reusable checkbox grid + stage editor + global section integration |
| #459 | PR-D Stage 11 (tool_review) + Stage 15 (hitl) curated | reviewer chain reorder, requester/timeout tile pickers |
| #460 | PR-E Stage 1 (input) + Stage 14 (evaluate) curated | system prompt textarea + starter chips, pipeline budgets shortcut |
| #461 | PR-F validation + warnings + start-from picker | StartFromPicker, severity-aware ValidationError, runValidation engine |

Total LOC delta: ~3000 net new (frontend tab) + ~50 backend (manifest_override).

## Stage curation coverage

7 of 21 stages have curated editors; the remaining 14 fall through to the schema-driven `StageGenericEditor` (artifact + StrategiesEditor + JsonSchemaForm).

| Order | Name | Editor |
|------|------|--------|
| 1 | input | Stage01InputEditor (system_prompt textarea + starter chips) |
| 2-5 | context / system / guard / cache | generic |
| 6 | api | Stage06ApiEditor (ModelConfigEditor + override toggle) |
| 7-9 | token / think / parse | generic |
| 10 | tools | Stage10ToolsEditor (ToolCheckboxGrid + MCP list + tool_binding) |
| 11 | tool_review | Stage11ToolReviewEditor (chain reorder + per-reviewer config) |
| 12-13 | agent / task_registry | generic |
| 14 | evaluate | Stage14EvaluateEditor (pipeline budgets shortcut + strategies) |
| 15 | hitl | Stage15HitlEditor (requester + timeout tile pickers) |
| 16-17 | loop / emit | generic |
| 18 | memory | Stage18MemoryEditor (strategy + persistence tile pickers + memory model) |
| 19-21 | summarize / persist / yield | generic |

Future cycles can promote any of the remaining 14 to curated as use patterns emerge.

## Architecture decisions, settled

1. **Backend**: single-shot Save uses `mode='blank' + manifest_override`. Backend patch (PR-A) added 1 schema field + 5-line service path.
2. **Draft state**: separate `useEnvironmentDraftStore` from persisted `useEnvironmentStore`. Draft survives in-app navigation (no auto-clear on tab unmount); browser-close warns via `beforeunload`; explicit Discard requires confirm when dirty.
3. **PipelineCanvas**: extended additively with optional `dirtyOrders` prop. SessionEnvironmentTab read-only mount unaffected.
4. **Validation**: severity-aware (`error` blocks Save, `warning` non-blocking). Runs on every patch + on initial seed. Lightweight built-in checks; per-artifact ConfigSchema required-field checks deferred (catalog API exposes them — easy follow-up).
5. **Hooks/Permissions/Skills**: kept global. Cross-linked from GlobalSection > "Linked" panel. Per-env scope would require manifest v4.0 + executor changes — out of scope.

## Out-of-scope (not done, not regressed)

- Per-env hooks/permissions/skills (would need manifest v4.0).
- Per-stage required-field validation driven by `catalogApi.stage(order).config_schema.required`. Currently the generic editor renders all schema fields but doesn't enforce required. Easy follow-up: `runValidation` can accept a per-stage schema lookup.
- Stage 19 (summarize) curated editor — executor implementation TBD.
- Inline MCP server add/edit form — currently cross-link to McpServersTab.
- Drag-to-reorder for the reviewer chain (PR-D used up/down buttons; works fine, just less ergonomic for long chains).

## Testing notes

PRs all passed GitGuardian + merged clean. The full Docker build was the gating CI for each PR. Backend `test_create_manifest_override.py` (3 tests) validates the manifest_override path; runs in pytest skipping cleanly when `geny_executor` isn't locally installed.

## Files touched (cumulative)

```
backend/
  controller/environment_controller.py
  service/environment/{schemas,service}.py
  tests/service/environment/test_create_manifest_override.py

frontend/src/
  types/environment.ts                                  # CreateEnvironmentPayload.manifest_override
  store/useEnvironmentDraftStore.ts                     # NEW (~330 lines)
  components/
    TabContent.tsx                                      # registered library_new
    TabNavigation.tsx                                   # GLOBAL_TAB_IDS + DEV_ONLY
    session-env/PipelineCanvas.tsx                      # +dirtyOrders prop
    library_new/                                        # NEW folder
      LibraryNewTab.tsx
      TopBar.tsx
      GlobalSection.tsx
      StageEditorPanel.tsx
      StageGenericEditor.tsx
      ToolCheckboxGrid.tsx
      StartFromPicker.tsx
      stages/
        Stage01InputEditor.tsx
        Stage06ApiEditor.tsx
        Stage10ToolsEditor.tsx
        Stage11ToolReviewEditor.tsx
        Stage14EvaluateEditor.tsx
        Stage15HitlEditor.tsx
        Stage18MemoryEditor.tsx

  lib/i18n/{en,ko}.ts                                   # tabs.library_new + libraryNewTab namespace
```

## Next cycle suggestions

Roughly in priority order:

1. **Per-stage required-field enforcement** — wire `catalogApi.stage(order).config_schema.required` into `runValidation`. Each curated editor already gets the introspection; just thread it through.
2. **Drag-to-reorder for reviewer chain** (Stage 11) — current up/down buttons are fine for ≤5 entries; would be nicer for long chains.
3. **Inline MCP server add/edit** in Stage 10 (extract `McpServerForm` from McpServersTab into a reusable component, embed into Stage10ToolsEditor).
4. **Curate Stage 9 (parse)** — model_override capable, often customised for output formatting.
5. **Curate Stage 17 (emit)** — output channels (chat / stream / log).
6. **Promote `library_new` over `library`** once the new tab reaches feature parity for editing existing envs (requires "load existing into draft" round-trip via newDraftFromExisting which already exists — just needs an "edit this env" button on the legacy Library cards that routes through it).
