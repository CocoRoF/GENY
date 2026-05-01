# PR 19 — entities/ category retirement (post-Memory-v2 hotfix)

> Date: 2026-05-01
> Pairs with: geny-executor v1.12.0 (release/1.12.0 → main)
> Trigger: User report that `entities/` *still* received auto-generated counterpart stubs after the 1.11 reflection-only fix.

## What

Memory v2 originally kept `entities/` as an auto-generated INDEX category — `entity_bootstrap` rewrote `entities/<sanitized>.md` on every `record_message` with the counterpart's interaction stats (turn counts, last seen, …). 1.11 stopped the *reflection LLM* from writing free-form notes there, but the host-side bootstrap was still producing stubs every turn.

The data those stubs captured was already 100% covered by:

- `dms/<cp>/<date>.md` frontmatter (per-counterpart-per-day index)
- `_vault_map.json` (counterpart counts surfaced in the system prompt)
- StreamTab UI (real-time per-counterpart cards)

Pure duplication. Retire the category entirely.

## Changes (Geny side)

- `service/memory/manager.py` — drop both `_maybe_bootstrap_entity` calls (the provider-adapter path and the legacy STM path) and delete the helper itself.
- `service/memory/entity_bootstrap.py` — `git rm` (entire module retired).
- `service/memory/structured_writer.py` — remove `entities` from `VALID_CATEGORIES`. Updated docstring + comment to mention 4 semantic groups (LEAF / INDEX / DERIVED / CURATED / ARTIFACT).
- `service/memory/types.py` — `MEMORY_CATEGORIES` no longer lists `entities`.
- `service/memory/conversation_archiver.py` — `build_links_to()` no longer emits `entities/<cp_safe>` wikilinks; only the daily journal + dms/ links remain.
- `service/memory/dm_archiver.py`, `service/memory/migrator.py`, `service/memory/curated_knowledge.py`, `service/memory/user_opsidian.py`, `service/memory/frontmatter.py`, `service/memory/dedupe_strategy.py` — comment / docstring scrub.
- `tools/built_in/memory_inspect_tools.py::_write_entity_note` — now writes to `insights/counterpart-<sanitized>.md` (was `entities/<sanitized>.md`). The note's title becomes `Counterpart distillation — <id>` and tags `["counterpart","distillation"]`. Output category = `insights` (DERIVED).
- `prompts/vtuber.md`, `prompts/templates/memory_ladder.md` — point `memory_distill` docs at the new `insights/counterpart-<id>.md` path.
- `pyproject.toml` — bump `geny-executor[web,cron]>=1.12.0,<2.0.0`.

## Tests touched

- `tests/service/memory/test_entity_bootstrap.py` — `git rm` (module retired).
- `tests/service/memory/test_record_message_archives.py::test_archive_runs_before_entity_bootstrap` — renamed to `test_archive_runs_before_dm_index`, asserts `archive → dm` ordering instead of `archive → bootstrap`.
- `tests/service/memory/test_conversation_archiver.py::test_build_links_to_*` — drop `entities/` assertions.
- `tests/service/memory/test_index_conversations.py` — sample frontmatter no longer includes `entities/82b10c90` in `links_to`.
- `tests/tools/test_memory_inspect_tools.py::test_distill_update_note_writes_when_writer_available` — assert `category == "insights"` and `filename_override == "insights/counterpart-sub-1.md"`.

## Frontend (frontend/src/...)

- `lib/memoryCategories.ts` — drop `entities` from `MEMORY_CATEGORIES`, `CATEGORY_ICONS`, `CATEGORY_COLORS`, `CATEGORY_FALLBACK_LABELS`, `isAutoManagedCategory()`. Drop unused `Users` icon import.
- `components/opsidian/OpsidianSidebar.tsx`, `components/user-opsidian/UserOpsidianView.tsx`, `components/curated-knowledge/CuratedKnowledgeView.tsx`, `components/knowledge-graph/graphConstants.ts` — local `CATEGORY_COLORS` / `CATEGORY_ICONS` and "New note" `<select>` dropdowns no longer offer `Entities`. Default-expanded category set updated.
- `components/tabs/MemoryTab.tsx` — comment update only.

## Plan.md

- Top revision banner added (post-1.12 entities/ retirement).
- §1.5 category matrix: `entities/` row removed; new row added for `insights/counterpart-<id>.md` (DERIVED, written on demand by `memory_distill`).
- §1.4 directory tree updated (no entities/ in INDEX, new line under DERIVED).
- §1.5 "Index" bullet revised to call out the retirement explicitly.

## Compatibility notes

- Existing on-disk `memory/entities/*.md` files are left in place on upgrade. They will index as `root` notes (since `entities` is no longer a recognised category prefix). The user explicitly waived back-compat ("기존 세션은 어차피 다 사라질 거니" — fresh sessions only), so no migration shipped.
- `geny-executor[web,cron]>=1.12.0` is required — earlier executors still allow `entities` in `NOTE_CATEGORIES` and pre-create the directory; pairing them with this Geny build will leave a permanently-empty `entities/` shell on disk but no errors.

## Verification

- `pytest tests/service/memory/ tests/tools/test_memory_inspect_tools.py` — green
- `pytest tests/contract/test_memory_provider_file_layout.py` (executor side) — green
- `ruff check + format --check` — clean
- Full executor suite — 2880 pass / 8 skip
