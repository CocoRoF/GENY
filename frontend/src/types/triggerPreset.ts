/**
 * Trigger Preset types — mirror of the backend Pydantic models in
 * ``service/trigger_preset/schemas.py``. Keep field names identical so
 * the FE can ``JSON.stringify`` payloads straight onto the network.
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

export interface CategoryConditions {
  requires_sub_worker_busy?: boolean;
  requires_sub_worker_idle?: boolean;
  time_window?: TimeWindow | null;
  min_consecutive?: number | null;
  max_consecutive?: number | null;
}

export interface TriggerCategory {
  id: string;
  label: string;
  kind: TriggerKind;
  conditions: CategoryConditions;
  cooldown_seconds: number;
  /** Locale → list of prompt variants (random pick at fire-time). */
  prompts: Record<string, string[]>;
}

export interface PhaseEvent {
  category_id: string;
  weight: number;
}

export interface TriggerPhase {
  id: string;
  label: string;
  min_consecutive: number;
  /** ``null`` = open-ended top bracket. */
  max_consecutive: number | null;
  events: PhaseEvent[];
}

export interface TriggerPresetManifest {
  enabled: boolean;
  timing: TriggerTiming;
  time_boundaries: TimeBoundaries;
  phases: TriggerPhase[];
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
  phase_count: number;
  category_count: number;
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
  /** Source preset id — when set, server deep-copies that preset's manifest. */
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
