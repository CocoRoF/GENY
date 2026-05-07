/**
 * Trigger Preset types — mirror of the backend Pydantic models in
 * ``service/trigger_preset/schemas.py``.
 *
 * Two-tier model:
 *
 *   • ``prompts`` — top-level library of natural-language texts.
 *   • ``categories`` — situations that reference prompts via id +
 *     per-reference weight.
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
 * Reusable natural-language prompt. Lives in the manifest's top-level
 * library; categories link to them via :class:`PromptRef`.
 *
 * ``content`` keys are locale codes (``en``, ``ko``, …); each value
 * is the **raw natural language** — the system adds tag prefixes at
 * fire time.
 */
export interface TriggerPrompt {
  id: string;
  label: string;
  content: Record<string, string>;
  tags: string[];
}

export interface PromptRef {
  prompt_id: string;
  weight: number;
}

export interface TriggerCategory {
  id: string;
  label: string;
  kind: TriggerKind;
  weight: number;

  consec_min: number;
  consec_max: number | null;
  requires_sub_worker_busy: boolean;
  requires_sub_worker_idle: boolean;
  time_window: TimeWindow | null;
  cooldown_seconds: number;

  /** Free-form ``[autonomous_signal: <here>]`` payload. Empty = omit. */
  autonomous_signal: string;

  prompt_refs: PromptRef[];
}

export interface TriggerPresetManifest {
  enabled: boolean;
  timing: TriggerTiming;
  time_boundaries: TimeBoundaries;
  prompts: TriggerPrompt[];
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
