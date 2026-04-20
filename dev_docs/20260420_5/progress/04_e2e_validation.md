# Progress/04 — End-to-end validation harness

**PR.** `test/tool-use-e2e-validation` (cycle 20260420_5, PR #4)
**Date.** 2026-04-20

---

## Purpose

PRs #1-#3 fixed the three defects this cycle investigated
(manifest-level declaration gap, role-default roster gap,
legacy `.process` references). This PR adds a regression harness
that would have caught every one of them, had it existed.

## New test modules

### 1. `tests/service/environment/test_tool_registry_roster.py`

Goes one layer deeper than `test_templates.py`: instead of asserting
what `manifest.tools.external` declares, it builds a real
`Pipeline` from the manifest with a fake `AdhocToolProvider` and
checks what ends up in `pipeline.tool_registry`.

Five tests:

- `test_worker_pipeline_registry_contains_platform_tools` — the
  worker env, built through the real pipeline factory with a
  provider that supplies every name, registers every platform +
  custom tool. Guards against a regression in
  `_register_external_tools` or a future change that drops
  platform tools from the worker roster.
- `test_vtuber_pipeline_registry_excludes_browser_tools` — even
  when the provider can supply `browser_*`, the VTuber pipeline
  does not register them. The filter must live at the manifest
  level (`_vtuber_tool_roster`), not in the provider.
- `test_worker_pipeline_registry_empty_when_provider_missing` —
  smoke-guards the inverse of the LOG2 failure. Manifest declares
  names but no provider supplies them → registry is empty. Proves
  that `.external` + providers is the *only* registration path;
  there is no silent fallback.
- `test_worker_pipeline_registers_zero_tools_when_roster_empty` —
  `external_tool_names=[]` on the worker → zero tools registered.
  No provider-catalog leakage.
- `test_vtuber_pipeline_registers_legacy_three_when_called_without_roster`
  — back-compat: `create_vtuber_env()` without args still yields
  the legacy three-web-tool roster through the full pipeline
  path.

### 2. `tests/service/environment/test_system_stage_tools.py`

Locks the v0.26.1 + v0.26.2 rebind invariants at the Geny layer so
any future executor upgrade that breaks them fails here, not at
runtime.

Three tests:

- `test_system_stage_registry_is_pipeline_registry` — SystemStage's
  `_tool_registry` is the exact object `pipeline.tool_registry`
  exposes. Identity check: if the rebind breaks, the LLM is shown
  zero tools.
- `test_tool_stage_registry_is_pipeline_registry` — ToolStage's
  `_registry` is the same object. Before v0.26.2 this diverged
  and every tool call resolved to `unknown_tool`.
- `test_system_and_tool_stage_share_populated_tools` — identity
  alone isn't enough (two stages could share an empty registry).
  Also verifies the shared registry contains the expected names.

### 3. `tests/integration/test_vtuber_dm_delegation.py`

The functional proof that PR #1 + PR #2 + v0.26.1/.2 compose into
a working VTuber → DM path.

Two tests:

- `test_vtuber_pipeline_dispatches_dm_call` — given a VTuber
  manifest with the full roster + a provider supplying a recording
  `geny_send_direct_message`, Stage 10 dispatches a pending DM call
  to the tool with the expected `target_session_id` / `message`
  input. This is the exact chain LOG2 reported as broken.
- `test_vtuber_pipeline_skips_browser_dispatch` — negative
  control: a pending `browser_navigate` call against the VTuber
  pipeline fails to resolve (unknown_tool) because the manifest
  filter excluded it. Guards against `browser_*` leaking back into
  the roster.

## What each test would have caught

| Defect | Test(s) that would have caught it |
|---|---|
| LOG1: VTuber "I only have web tools" | `test_vtuber_pipeline_registry_excludes_browser_tools` + `test_install_templates_propagates_to_vtuber` (PR #2) |
| LOG2: `geny_send_direct_message` → `ERROR` | `test_vtuber_pipeline_dispatches_dm_call` |
| v0.26.1 rebind regression | `test_system_stage_registry_is_pipeline_registry` |
| v0.26.2 rebind regression | `test_tool_stage_registry_is_pipeline_registry` |
| `_DEFAULT_BUILT_IN_TOOLS` resurrection | `test_worker_pipeline_registry_contains_platform_tools` |
| Boot passing `get_custom_names()` again | `test_install_environment_templates_passes_all_names` + `test_worker_pipeline_registry_empty_when_provider_missing` |

## Intentional scope

Not in this harness:

- Live Anthropic API + full VTuber → Sub-Worker inbox round-trip.
  That requires the full `AgentSessionManager` + `SessionStore` +
  `EnvironmentService` bootstrap with a live API key. Manual
  smoke (plan `04_end_to_end_validation.md` §Verification) is the
  check there.
- File endpoint regressions (PR #3). The existing
  `backend/tests/` layout doesn't carry a live AgentSession
  fixture for the FastAPI test client; wiring one for a mechanical
  one-line replacement would be disproportionate. The PR #3
  progress doc notes this trade-off.

## Verification

```
$ python -m pytest tests/ -q
......................................                                   [100%]
38 passed in 0.31s
$ python -m pytest tests/integration -q
....                                                                     [100%]
4 passed in 0.27s
```

All green. New tests: 10 (5 roster + 3 SystemStage/ToolStage + 2
VTuber DM). Pre-existing suite unchanged (28).

## Rollback

Pure test additions — rollback removes coverage but changes no
behaviour.
