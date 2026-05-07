/**
 * Trigger preset runtime simulator — pure helpers shared by the
 * editor's category view + scenario bar.
 *
 * This is the single source of truth for "what fires under scenario
 * X?" and is kept in *exact* lockstep with the backend's
 * :func:`_category_eligible` + two-stage roulette in
 * :mod:`service.vtuber.thinking_trigger`.
 *
 * Two-stage runtime (categories-only schema, cycle 20260507):
 *
 *   ① Find every Category whose conditions hold under the scenario
 *      (consec range + sub-worker state + time window + cooldown).
 *   ② Stage-1 roulette across matching categories by ``Category.weight``
 *      → one situation wins.
 *   ③ Stage-2 roulette across that category's prompts by per-prompt
 *      ``weight`` → one wording wins.
 *   ④ Render: ``[KIND_TRIGGER:id] [autonomous_signal: …] {content}``
 */

import type {
  TimeWindow,
  TriggerCategory,
  TriggerPresetManifest,
} from '@/types/triggerPreset';

/** Possible Sub-Worker states for the scenario picker. */
export type SubWorkerState = 'busy' | 'idle' | 'unlinked';

/** Holds every input the runtime's condition gate reads. */
export interface RuntimeScenario {
  consecutive: number;
  subWorker: SubWorkerState;
  timeWindow: TimeWindow;
  /**
   * Whether to honour per-category cooldown gates. Off in the editor
   * by default — the runtime cooldown depends on per-session fire
   * history, not anything the operator can preview deterministically.
   */
  honourCooldowns: boolean;
}

export interface BlockedReason {
  code:
    | 'consec_below'
    | 'consec_above'
    | 'sub_worker_busy_required'
    | 'sub_worker_idle_required'
    | 'wrong_time_window'
    | 'cooldown'
    | 'no_prompts'
    | 'zero_weight';
  message: string;
}

export interface SimulatedCategory {
  category: TriggerCategory;
  /** When non-null, this category is filtered out. */
  blocked: BlockedReason | null;
  /**
   * Probability under the current scenario, expressed as a percentage.
   * 0 if blocked. Sum across non-blocked categories is 100.
   */
  effectivePct: number;
}

export interface ScenarioSimulation {
  /** Every category, ordered as in the manifest, with eligibility. */
  categories: SimulatedCategory[];
  /** Sum of weights of surviving categories. */
  totalEligibleWeight: number;
}

// ── Helpers ──────────────────────────────────────────────────────

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

export function currentTimeWindow(
  manifest: TriggerPresetManifest,
  nowDate: Date = new Date(),
): TimeWindow {
  const utcHour = nowDate.getUTCHours();
  const kstHour = (utcHour + 9) % 24;
  return timeWindowForHour(kstHour, manifest.time_boundaries);
}

/**
 * Evaluate one category's condition gate against the scenario.
 * Mirrors :func:`service.vtuber.thinking_trigger._category_eligible`.
 * Cooldown is intentionally ignored unless ``honourCooldowns`` is
 * true — see :class:`RuntimeScenario`.
 */
export function evaluateConditions(
  category: TriggerCategory,
  scenario: RuntimeScenario,
): BlockedReason | null {
  if (scenario.consecutive < category.consec_min) {
    return {
      code: 'consec_below',
      message: `최소 연속 트리거 ${category.consec_min}회 필요 (현재 ${scenario.consecutive}회)`,
    };
  }
  if (
    category.consec_max !== null &&
    scenario.consecutive > category.consec_max
  ) {
    return {
      code: 'consec_above',
      message: `최대 연속 트리거 ${category.consec_max}회 초과 (현재 ${scenario.consecutive}회)`,
    };
  }
  if (
    category.requires_sub_worker_busy &&
    scenario.subWorker !== 'busy'
  ) {
    return {
      code: 'sub_worker_busy_required',
      message: 'Sub-Worker가 작업 중일 때만 발사',
    };
  }
  if (category.requires_sub_worker_idle) {
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
    category.time_window !== null &&
    category.time_window !== scenario.timeWindow
  ) {
    return {
      code: 'wrong_time_window',
      message: `${category.time_window} 시간대에만 발사 (현재: ${scenario.timeWindow})`,
    };
  }
  return null;
}

/** Render condition chips for a category in priority order. */
export function describeConditions(
  category: TriggerCategory,
): { label: string; tone: 'info' | 'warn' | 'neutral' }[] {
  const out: { label: string; tone: 'info' | 'warn' | 'neutral' }[] = [];

  if (category.consec_min > 0 || category.consec_max !== null) {
    const min = category.consec_min;
    const max = category.consec_max;
    let label: string;
    if (min === max) {
      label = `consec = ${min}`;
    } else if (max === null) {
      label = `consec ≥ ${min}`;
    } else if (min === 0) {
      label = `consec ≤ ${max}`;
    } else {
      label = `consec ${min}~${max}`;
    }
    out.push({ label, tone: 'info' });
  }

  if (category.requires_sub_worker_busy) {
    out.push({ label: 'Sub-Worker busy', tone: 'warn' });
  }
  if (category.requires_sub_worker_idle) {
    out.push({ label: 'Sub-Worker idle', tone: 'warn' });
  }
  if (category.time_window) {
    out.push({ label: `${category.time_window} 시간대`, tone: 'info' });
  }
  if (category.cooldown_seconds > 0) {
    out.push({
      label: `쿨다운 ${category.cooldown_seconds}s`,
      tone: 'neutral',
    });
  }
  return out;
}

/**
 * Run all categories against a scenario and produce per-category
 * effective probabilities.
 *
 *   1. Mark each category eligible / blocked via ``evaluateConditions``.
 *   2. Drop empty-prompt categories (eligible-but-no-output).
 *   3. Sum surviving weights → ``totalEligibleWeight``.
 *   4. Each surviving category's pct = weight / total * 100.
 */
export function simulate(
  manifest: TriggerPresetManifest,
  scenario: RuntimeScenario,
): ScenarioSimulation {
  const draft: SimulatedCategory[] = manifest.categories.map((cat) => {
    if (cat.weight <= 0) {
      return {
        category: cat,
        blocked: { code: 'zero_weight', message: '카테고리 가중치 0' },
        effectivePct: 0,
      };
    }
    if (cat.prompts.length === 0) {
      return {
        category: cat,
        blocked: { code: 'no_prompts', message: '프롬프트가 비어있음' },
        effectivePct: 0,
      };
    }
    const blocked = evaluateConditions(cat, scenario);
    return {
      category: cat,
      blocked,
      effectivePct: 0,
    };
  });

  const surviving = draft.filter((d) => d.blocked === null);
  const total = surviving.reduce((sum, d) => sum + d.category.weight, 0);
  if (total > 0) {
    for (const d of surviving) {
      d.effectivePct = (d.category.weight / total) * 100;
    }
  }

  return {
    categories: draft,
    totalEligibleWeight: total,
  };
}

/**
 * Construct the final-rendered prompt string the runtime would send.
 * Pure mirror of :func:`service.trigger_preset.schemas.render_prompt`.
 *
 * Used in the editor for the "이 트리거가 발사되면 이렇게 보내집니다"
 * preview chip on each prompt row.
 */
export function renderPrompt(
  category: TriggerCategory,
  content: string,
): string {
  const tagToken =
    category.kind === 'activity' ? 'ACTIVITY_TRIGGER' : 'THINKING_TRIGGER';
  const head = `[${tagToken}:${category.id}]`;
  const parts: string[] = [head];
  const signal = (category.autonomous_signal || '').trim();
  if (signal) {
    parts.push(`[autonomous_signal: ${signal}]`);
  }
  parts.push(content.trim());
  return parts.join(' ');
}
