-- CreatureState MVP schema (cycle 20260421_9 PR-X3-2).
--
-- One row per character. Payload is stored as a JSON blob so schema
-- churn during X3/X4 doesn't require column-level migrations. After
-- stabilization (post-X4), query-hot fields (e.g. life_stage) can be
-- promoted to dedicated columns via a v2 migration.
--
-- row_version implements optimistic concurrency — see provider.apply().

CREATE TABLE IF NOT EXISTS creature_state (
    character_id          TEXT PRIMARY KEY,
    owner_user_id         TEXT NOT NULL,
    schema_version        INTEGER NOT NULL,
    data_json             TEXT NOT NULL,
    last_tick_at          TEXT NOT NULL,
    last_interaction_at   TEXT,
    updated_at            TEXT NOT NULL,
    row_version           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_creature_state_owner
    ON creature_state(owner_user_id);
