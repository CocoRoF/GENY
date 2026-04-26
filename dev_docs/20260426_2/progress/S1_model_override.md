# S.1 — Per-stage model_override editor

**PR:** TBD
**Status:** Merged TBD
**Files changed:**
- `frontend/src/components/tabs/BuilderTab.tsx` — `StageDraft.modelOverrideText` field + populate from `entry.model_override` + dirty check + `handleSave` validation + new editor section after Chains.

## What it changes

The per-stage detail (Stages view) gets a new "Model override (optional)" textarea. Operators can paste a subset of `ModelConfig` fields (e.g. `{"model": "claude-haiku-3-5", "temperature": 0.2}`) to override the pipeline-level model just for that stage — the executor's per-stage `model_override` slot already supports this; previously the only way to set it was via raw JSON manifest import.

Empty textarea = inherit the pipeline-level model (no override). Validation:
- Empty / whitespace → `model_override` not sent (treated as "leave as-is").
- Non-empty → must parse as JSON object; validation error surfaces inline above the form.

The dirty check now considers the override text alongside the other stage fields, so the Save button enables correctly.

## Why

Audit (cycle 20260426_2, analysis/02 Tier 2) — `model_override` per stage was supported by the backend `update_stage` service method but had no UI surface. Operators with mixed-model pipelines had to use ImportManifestModal.

## UX choice

Used a JSON textarea instead of a full structured form (mini-`ModelConfigEditor`) for two reasons:
1. Per-stage overrides are rare; a 5-line textarea avoids cluttering the stage detail with rarely-used fields.
2. Operators editing per-stage overrides typically already know the `ModelConfig` field names.

If usage telemetry shows this is a common edit, a structured form is a follow-up sprint.

## Out of scope

- `tool_binding` per stage (s10 only) — sprint S.2.
- "Clear override" affordance — to remove an existing override, edit the manifest via ImportManifestModal. Same convention as the Pipeline / Model editors.
