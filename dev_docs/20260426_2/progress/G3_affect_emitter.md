# G.3 — Affect emitter max_tags knob

**PR:** TBD
**Status:** Merged TBD
**Files changed:**
- `backend/service/settings/sections.py` — new `AffectConfigSection` (single field: `max_tags_per_turn`).
- `backend/service/settings/install.py` — `register_section("affect", AffectConfigSection)`.
- `backend/service/settings/known_sections.py` — `"affect": ["service.emit.chain_install"]` reader.
- `backend/tests/service/settings/test_known_sections.py` — parametrized list adds `affect`.
- `backend/service/emit/chain_install.py` — `_resolve_max_tags` helper; `install_affect_tag_emitter` reads from settings.json when caller passes `None`.

## What it changes

`AffectTagEmitter.max_tags_per_turn` (Geny's per-turn cap on `[emotion]` tags consumed and folded into CreatureState mutations) is now editable via FrameworkSettings instead of code-only.

Resolution:
1. Explicit caller arg wins.
2. `settings.json:affect.max_tags_per_turn` next.
3. Executor's `DEFAULT_MAX_TAG_MUTATIONS_PER_TURN` constant as the floor.

## Why

Audit (cycle 20260426_2, analysis/02 Tier 6) — single hardcoded knob; operators tuning emotional response density had no UI surface.

## Out of scope

- Per-session affect config — global default only for now.
- Other AffectTagEmitter knobs (none exposed today; future PRs can extend `AffectConfigSection`).
