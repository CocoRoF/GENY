/**
 * Trigger Preset types — mirror of the backend Pydantic models in
 * ``service/trigger_preset/schemas.py``.
 *
 * Cycle 20260507 redesign:
 *
 *   • Phases removed. consec range now lives on each category as a
 *     plain condition (``consec_min`` / ``consec_max``).
 *   • Prompts are embedded inside categories with their own weights.
 *   • The ``[KIND_TRIGGER:id] [autonomous_signal: …]`` prefix is no
 *     longer baked into prompt content — the server renders it at
 *     fire time from the category's metadata.
 */

export type TriggerKind = 'thinking' | 'activity';
export type TimeWindow = 'morning' | 'afternoon' | 'evening' | 'night';

export interface TriggerTiming {
  base_idle_seconds: number;
  max_idle_seconds: number;
  tick_interval_seconds: number;
  sub_worker_working_cooldown_seconds: number;
  adaptive_scale_triggers: number;
}

export interface TimeBoundaries {
  morning_start: number;
  afternoon_start: number;
  evening_start: number;
  night_start: number;
}

/**
 * One natural-language prompt variant inside a category.
 *
 * ``content`` keys are locale codes (``en``, ``ko``, …); each value
 * is the **raw natural language** — no ``[THINKING_TRIGGER:…]`` tag,
 * no ``[autonomous_signal: …]`` prefix. The server constructs those
 * from the parent category's metadata at fire time.
 */
export interface TriggerPromptVariant {
  weight: number;
  content: Record<string, string>;
}

export interface TriggerCategory {
  id: string;
  label: string;
  kind: TriggerKind;
  weight: number;

  // Conditions (when this situation applies)
  consec_min: number;
  consec_max: number | null;
  requires_sub_worker_busy: boolean;
  requires_sub_worker_idle: boolean;
  time_window: TimeWindow | null;
  cooldown_seconds: number;

  /** Free-form ``[autonomous_signal: <here>]`` payload. Empty = omit. */
  autonomous_signal: string;

  prompts: TriggerPromptVariant[];
}

export interface TriggerPresetManifest {
  enabled: boolean;
  timing: TriggerTiming;
  time_boundaries: TimeBoundaries;
  categories: TriggerCategory[];
}

export interface TriggerPresetSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  enabled: boolean;
  category_count: number;
  prompt_count: number;
}

export interface TriggerPresetDetail {
  id: string;
  name: string;
  description: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  manifest: TriggerPresetManifest;
}

export interface CreateTriggerPresetPayload {
  name: string;
  description?: string;
  tags?: string[];
  manifest?: TriggerPresetManifest;
  clone_from?: string;
}

export interface UpdateTriggerPresetPayload {
  name?: string;
  description?: string;
  tags?: string[];
}

export interface TriggerPresetSessionsResponse {
  preset_id: string;
  active_count: number;
  sessions: Array<{
    session_id: string;
    session_name?: string | null;
    status?: string | null;
    role?: string | null;
  }>;
}
