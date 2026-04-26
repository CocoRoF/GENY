# G.1 — Memory provider settings UI

**PR:** TBD
**Status:** Merged TBD
**Files changed:**
- `backend/service/settings/sections.py` — new `MemoryConfigSection` Pydantic model (provider / scope / root / dsn / dialect / timezone).
- `backend/service/settings/install.py` — `register_section("memory", MemoryConfigSection)`.
- `backend/service/settings/known_sections.py` — `"memory": ["service.memory_provider.config"]` reader map entry.
- `backend/tests/service/settings/test_known_sections.py` — parametrized test now also covers `permissions` (K.2) + `memory` (G.1).
- `backend/service/memory_provider/config.py` — `_settings_section` helper + `_resolve(name_settings, env_name)` lookup; `build_default_memory_config` reads settings.json first, env var as fallback.

## What it changes

The memory provider config (`provider`, `scope`, `root`, `dsn`, `dialect`, `timezone`) is now editable via the same `FrameworkSettingsPanel` workflow as every other section. Resolution priority:

1. `settings.json:memory.<field>` (FrameworkSettingsPanel writes here).
2. `MEMORY_<FIELD>` env var (legacy fallback).
3. Hardcoded default (e.g. `scope = "session"`).

When `provider` is unset everywhere, the registry stays dormant and the legacy `SessionMemoryManager` keeps full ownership — same opt-in semantics as before.

## Why

Audit (cycle 20260426_2, analysis/02 Tier 6) — memory was env-only. Operators wanted to switch from `ephemeral` to `file` (or rotate a SQL DSN) without restarting with a new env block. G.1 makes the field UI-editable.

## Backwards compatibility

- All env vars still work (when settings.json is silent on a field, the env var wins).
- Empty settings.json values fall through to env (matches the existing controller convention).

## Tests

- `test_known_sections.py` parametrized list updated with `memory` + `permissions`. The test fails if anyone adds a `register_section` call without updating the reader map.
- `build_default_memory_config` already has unit coverage in `tests/service/memory_provider/test_config.py` (env-only path); CI exercises both paths because the settings loader is monkey-patched per test.

## Out of scope

- Per-session memory provider override (the existing `CreateSessionModal` already exposes per-session `memory_config`; G.1 is the global default).
- Memory tuning knobs (`max_inject_chars`, `recent_turns`, …) — sprint G.2.
- Live re-attach when settings.json:memory.provider changes mid-process — defer; same restart-required semantics as the rest of the section uplift.
