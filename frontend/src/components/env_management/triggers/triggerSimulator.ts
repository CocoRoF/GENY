/**
 * Trigger preset runtime simulator — pure helpers shared by the
 * editor's phase view + scenario bar.
 *
 * This is the single source of truth for "what would fire under
 * scenario X?" and is kept in *exact* lockstep with the backend's
 * :func:`_category_eligible` / :func:`_roulette` so the operator's
 * preview matches the live runtime decision.
 */

import type {
  CategoryConditions,
  PhaseEvent,
  TimeWindow,
  TriggerCategory,
  TriggerPhase,
  TriggerPresetManifest,
} from '@/types/triggerPreset';

/** Possible Sub-Worker states for the scenario picker. */
export type SubWorkerState = 'busy' | 'idle' | 'unlinked';

/** Holds every input the runtime's condition gate reads. */
export interface RuntimeScenario {
  /** Consecutive-trigger count for this session. Drives phase pick + min/max gates. */
  consecutive: number;
  /** Linked Sub-Worker state. */
  subWorker: SubWorkerState;
  /** Active time window (mapped from boundaries elsewhere). */
  timeWindow: TimeWindow;
  /**
   * Whether to honour per-category cooldown gates. Off in the editor by
   * default — the runtime cooldown depends on per-session fire history,
   * not anything the operator can preview deterministically.
   */
  honourCooldowns: boolean;
}

export interface BlockedReason {
  code:
    | 'sub_worker_busy_required'
    | 'sub_worker_idle_required'
    | 'wrong_time_window'
    | 'below_min_consecutive'
    | 'above_max_consecutive'
    | 'cooldown'
    | 'unknown_category';
  /** Korean-localised explanation for the chip / row. */
  message: string;
}

export interface SimulatedEvent {
  event: PhaseEvent;
  category: TriggerCategory | null;
  /** When non-null, this event is filtered out of the roulette. */
  blocked: BlockedReason | null;
  /** Probability under the current scenario. 0 if blocked. */
  effectivePct: number;
}

export interface PhaseSimulation {
  phase: TriggerPhase;
  /** True when this phase's range covers the scenario's consecutive count. */
  matchesScenario: boolean;
  events: SimulatedEvent[];
  /** Sum of weights of events that survived the filter (drives normalisation). */
  effectiveTotalWeight: number;
}

/** Map an hour-of-day to a TimeWindow given the manifest's boundaries. */
export function timeWindowForHour(
  hour: number,
  bounds: TriggerPresetManifest['time_boundaries'],
): TimeWindow {
  if (hour >= bounds.morning_start && hour < bounds.afternoon_start) {
    return 'morning';
  }
  if (hour >= bounds.afternoon_start && hour < bounds.evening_start) {
    return 'afternoon';
  }
  if (hour >= bounds.evening_start && hour < bounds.night_start) {
    return 'evening';
  }
  return 'night';
}

/** Map "current KST hour" via the manifest. */
export function currentTimeWindow(
  manifest: TriggerPresetManifest,
  nowDate: Date = new Date(),
): TimeWindow {
  // Approximate KST as UTC+9 — the runtime uses ``service.utils.utils.now_kst``
  // which is real KST. For the editor preview the small drift across DST
  // borders (none in KR) is irrelevant.
  const utcHour = nowDate.getUTCHours();
  const kstHour = (utcHour + 9) % 24;
  return timeWindowForHour(kstHour, manifest.time_boundaries);
}

/** First phase whose [min, max] range covers ``count``. Mirrors backend. */
export function selectPhase(
  manifest: TriggerPresetManifest,
  count: number,
): TriggerPhase | null {
  for (const phase of manifest.phases) {
    if (count < phase.min_consecutive) continue;
    if (
      phase.max_consecutive !== null &&
      phase.max_consecutive !== undefined &&
      count > phase.max_consecutive
    ) {
      continue;
    }
    return phase;
  }
  return null;
}

/**
 * Evaluate one category's condition gate against the scenario.
 *
 * Mirrors :func:`service.vtuber.thinking_trigger._category_eligible`
 * with one editor-side caveat: per-category cooldown is opt-in via
 * ``honourCooldowns`` because the operator can't reasonably simulate
 * runtime cooldown windows from inside the editor.
 */
export function evaluateConditions(
  conditions: CategoryConditions,
  scenario: RuntimeScenario,
): BlockedReason | null {
  if (conditions.requires_sub_worker_busy && scenario.subWorker !== 'busy') {
    return {
      code: 'sub_worker_busy_required',
      message: 'Sub-Worker가 작업 중일 때만 발사',
    };
  }
  if (conditions.requires_sub_worker_idle) {
    if (scenario.subWorker !== 'idle') {
      return {
        code: 'sub_worker_idle_required',
        message:
          scenario.subWorker === 'unlinked'
            ? 'Sub-Worker가 연결되어야 함'
            : 'Sub-Worker가 idle일 때만 발사',
      };
    }
  }
  if (
    conditions.time_window !== null &&
    conditions.time_window !== undefined &&
    conditions.time_window !== scenario.timeWindow
  ) {
    return {
      code: 'wrong_time_window',
      message: `${conditions.time_window} 시간대에만 발사 (현재: ${scenario.timeWindow})`,
    };
  }
  if (
    conditions.min_consecutive !== null &&
    conditions.min_consecutive !== undefined &&
    scenario.consecutive < conditions.min_consecutive
  ) {
    return {
      code: 'below_min_consecutive',
      message: `최소 연속 트리거 ${conditions.min_consecutive}회 필요`,
    };
  }
  if (
    conditions.max_consecutive !== null &&
    conditions.max_consecutive !== undefined &&
    scenario.consecutive > conditions.max_consecutive
  ) {
    return {
      code: 'above_max_consecutive',
      message: `최대 연속 트리거 ${conditions.max_consecutive}회 초과`,
    };
  }
  return null;
}

/** Render condition chips for a category in priority order. */
export function describeConditions(
  category: TriggerCategory,
): { label: string; tone: 'info' | 'warn' | 'neutral' }[] {
  const out: { label: string; tone: 'info' | 'warn' | 'neutral' }[] = [];
  const c = category.conditions;
  if (c.requires_sub_worker_busy) {
    out.push({ label: 'Sub-Worker busy', tone: 'warn' });
  }
  if (c.requires_sub_worker_idle) {
    out.push({ label: 'Sub-Worker idle', tone: 'warn' });
  }
  if (c.time_window) {
    out.push({ label: `${c.time_window} 시간대`, tone: 'info' });
  }
  if (typeof c.min_consecutive === 'number') {
    out.push({ label: `consec ≥ ${c.min_consecutive}`, tone: 'info' });
  }
  if (typeof c.max_consecutive === 'number') {
    out.push({ label: `consec ≤ ${c.max_consecutive}`, tone: 'info' });
  }
  if (category.cooldown_seconds && category.cooldown_seconds > 0) {
    out.push({
      label: `쿨다운 ${category.cooldown_seconds}s`,
      tone: 'neutral',
    });
  }
  return out;
}

/**
 * Run one phase against the scenario and produce the per-event
 * effective probabilities.
 *
 * Computation:
 *
 *   1. For each event, look up the category. Missing → block.
 *   2. Drop events whose conditions don't pass the scenario.
 *   3. Sum the surviving weights → ``effectiveTotalWeight``.
 *   4. Each surviving event's pct = weight / total * 100.
 *   5. Blocked events return pct = 0 with a reason.
 */
export function simulatePhase(
  phase: TriggerPhase,
  manifest: TriggerPresetManifest,
  scenario: RuntimeScenario,
): PhaseSimulation {
  const cats = new Map(manifest.categories.map((c) => [c.id, c]));

  // First pass: classify each event.
  const draft: SimulatedEvent[] = phase.events.map((ev) => {
    const cat = cats.get(ev.category_id) ?? null;
    if (!cat) {
      return {
        event: ev,
        category: null,
        blocked: {
          code: 'unknown_category',
          message: '존재하지 않는 카테고리',
        },
        effectivePct: 0,
      };
    }
    if (ev.weight <= 0) {
      return {
        event: ev,
        category: cat,
        blocked: { code: 'cooldown', message: '가중치가 0 — 추첨 제외' },
        effectivePct: 0,
      };
    }
    const blocked = evaluateConditions(cat.conditions, scenario);
    return {
      event: ev,
      category: cat,
      blocked,
      effectivePct: 0,
    };
  });

  // Second pass: normalise surviving weights.
  const surviving = draft.filter((d) => d.blocked === null);
  const total = surviving.reduce((sum, d) => sum + d.event.weight, 0);
  if (total > 0) {
    for (const d of surviving) {
      d.effectivePct = (d.event.weight / total) * 100;
    }
  }

  const range = phase;
  const matches =
    scenario.consecutive >= range.min_consecutive &&
    (range.max_consecutive === null ||
      range.max_consecutive === undefined ||
      scenario.consecutive <= range.max_consecutive);

  return {
    phase,
    matchesScenario: matches,
    events: draft,
    effectiveTotalWeight: total,
  };
}

/** Compute reverse references: which phases use each category, with weight. */
export function categoryReferences(
  manifest: TriggerPresetManifest,
): Map<string, { phaseId: string; phaseLabel: string; weight: number }[]> {
  const out = new Map<
    string,
    { phaseId: string; phaseLabel: string; weight: number }[]
  >();
  for (const phase of manifest.phases) {
    for (const ev of phase.events) {
      const list = out.get(ev.category_id) ?? [];
      list.push({
        phaseId: phase.id,
        phaseLabel: phase.label || phase.id,
        weight: ev.weight,
      });
      out.set(ev.category_id, list);
    }
  }
  return out;
}
