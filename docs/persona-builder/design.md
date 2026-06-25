# Persona Builder (Geny-only)

A tool to author a character's **personality** as structured data and inject it into
a session's system prompt. Deliberately **not** in geny-executor — persona authoring
is a Geny product feature, not a general agent-runtime capability.

## Model — `PersonaPresetDefinition`
Structured persona config (one JSONB `data` payload, no migrations for new fields):
- **Frameworks**: `mbti` (16), `enneagram` (9, +wings), `archetype` (츤데레/쿨데레/얀데레/… 12)
- **OCEAN** (Big Five core, 0–100 ×5): openness, conscientiousness, extraversion, agreeableness, neuroticism
- **Style** (expressive axes, 0–100 ×9): warmth, humor, playfulness, formality, assertiveness, verbosity, emoji, enthusiasm, directness
- **Speech**: `honorific` (auto/banmal/jondaetmal/mixed), self_reference, catchphrases, verbal_tics
- **Emotion**: default_mood + expressiveness + preferred_tags (from `text_sanitizer.EMOTION_TAGS`)
- **Identity**: display_name, age_vibe, role, interests, backstory
- `prompt_override` — verbatim escape hatch when a power user hand-tunes the result

## Compiler — `compile_persona(defn) -> str`
Struct → a lean English `## Character` block (identity · temperament · manner · feeling ·
interests). Mid-range slider values are skipped; tools are never described (prompt-diet
policy). The role base prompt keeps the single output-language directive; the persona
only adds the Korean register (반말/존댓말) as style.

## Storage + API
- `service/persona_presets/` store (DB-only, UNIQUE preset_id+name) mirroring sandbox_tool_packs.
- `controller/persona_presets_controller.py`: `GET /api/persona-presets`, `/frameworks`,
  `/{id}`; `POST ""`, `/compile` (live preview); `PUT /{id}`; `DELETE /{id}`.
- Boot: store wired + 4 starter presets seeded (밝은 친구 / 츤데레 / 쿨데레 / 프로 비서).

## Injection
An environment attaches a preset via `host_selections.extras.persona_preset_id`. At
session build, `AgentSessionManager._compile_env_persona(env_id)` compiles it and
**prepends** it (`{persona}\n\n---\n\n{system_prompt}`) before `set_static_override`, so
the character identity leads, ahead of the role/behaviour base. Best-effort: a missing
preset never blocks session creation.

## Frontend (phase 2)
A `persona` section in the environment editor: framework pickers + OCEAN/style sliders +
speech/emotion/identity inputs + live compiled-prompt preview; save as a reusable preset
and attach it to the environment.
