/**
 * Trigger preset runtime simulator — pure helpers shared by the
 * editor's category view + scenario bar.
 *
 * Lockstep with the backend's :func:`_category_eligible` + two-stage
 * roulette + prompt-library resolution in
 * :mod:`service.vtuber.thinking_trigger`.
 *
 * Two-stage runtime (two-tier schema, cycle 20260507):
 *
 *   ① Find every Category whose conditions hold under the scenario
 *      (consec range + sub-worker state + time window + cooldown).
 *   ② Stage-1 roulette across matching categories by ``Category.weight``
 *      → one situation wins.
 *   ③ Stage-2 roulette across that category's ``prompt_refs`` → one
 *      prompt id wins.
 *   ④ Resolve the id against the manifest's prompt library and render:
 *      ``[KIND_TRIGGER:id] [autonomous_signal: …] {content}``
 */

import type {
  TimeWindow,
  TriggerCategory,
  TriggerPresetManifest,
  TriggerPrompt,
} from '@/types/triggerPreset';

export type SubWorkerState = 'busy' | 'idle' | 'unlinked';

export interface RuntimeScenario {
  consecutive: number;
  subWorker: SubWorkerState;
  timeWindow: TimeWindow;
  /** Whether the user is sharing their screen (gates requires_screen_active). */
  screenActive: boolean;
  honourCooldowns: boolean;
}

export interface BlockedReason {
  code:
    | 'consec_below'
    | 'consec_above'
    | 'sub_worker_busy_required'
    | 'sub_worker_idle_required'
    | 'screen_required'
    | 'wrong_time_window'
    | 'cooldown'
    | 'no_prompt_refs'
    | 'no_resolvable_prompts'
    | 'zero_weight';
  message: string;
}

export interface SimulatedCategory {
  category: TriggerCategory;
  blocked: BlockedReason | null;
  effectivePct: number;
}

export interface ScenarioSimulation {
  categories: SimulatedCategory[];
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
  if (category.requires_screen_active && !scenario.screenActive) {
    return {
      code: 'screen_required',
      message: '사용자가 화면 공유 중일 때만 발사',
    };
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
 * effective probabilities. Categories whose ``prompt_refs`` resolve
 * to no available prompts are blocked with ``no_resolvable_prompts``
 * (matches the backend's safety filter).
 */
export function simulate(
  manifest: TriggerPresetManifest,
  scenario: RuntimeScenario,
): ScenarioSimulation {
  const promptIds = new Set(manifest.prompts.map((p) => p.id));

  const draft: SimulatedCategory[] = manifest.categories.map((cat) => {
    if (cat.weight <= 0) {
      return {
        category: cat,
        blocked: { code: 'zero_weight', message: '카테고리 가중치 0' },
        effectivePct: 0,
      };
    }
    if (cat.prompt_refs.length === 0) {
      return {
        category: cat,
        blocked: {
          code: 'no_prompt_refs',
          message: '연결된 프롬프트 없음',
        },
        effectivePct: 0,
      };
    }
    const resolved = cat.prompt_refs.filter(
      (r) => r.weight > 0 && promptIds.has(r.prompt_id),
    );
    if (resolved.length === 0) {
      return {
        category: cat,
        blocked: {
          code: 'no_resolvable_prompts',
          message: '연결된 프롬프트가 라이브러리에 없거나 가중치 0',
        },
        effectivePct: 0,
      };
    }
    const blocked = evaluateConditions(cat, scenario);
    return { category: cat, blocked, effectivePct: 0 };
  });

  const surviving = draft.filter((d) => d.blocked === null);
  const total = surviving.reduce((sum, d) => sum + d.category.weight, 0);
  if (total > 0) {
    for (const d of surviving) {
      d.effectivePct = (d.category.weight / total) * 100;
    }
  }

  return { categories: draft, totalEligibleWeight: total };
}

/** Construct the final-rendered prompt string the runtime would send. */
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

// ── Reverse references — for the prompt library view ─────────────

export interface PromptUsage {
  categoryId: string;
  categoryLabel: string;
  weight: number;
}

/** Map of ``prompt_id → list of categories referencing it``. */
export function promptUsageMap(
  manifest: TriggerPresetManifest,
): Map<string, PromptUsage[]> {
  const out = new Map<string, PromptUsage[]>();
  for (const cat of manifest.categories) {
    for (const ref of cat.prompt_refs) {
      const list = out.get(ref.prompt_id) ?? [];
      list.push({
        categoryId: cat.id,
        categoryLabel: cat.label || cat.id,
        weight: ref.weight,
      });
      out.set(ref.prompt_id, list);
    }
  }
  return out;
}

export type { TriggerPrompt };
