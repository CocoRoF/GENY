'use client';

/**
 * ScenarioBar — picks the runtime scenario the phase matrix is
 * previewed against.
 *
 * Three orthogonal axes mirror the backend's condition gates:
 *
 *   1. Consec count → which phase matches
 *   2. Sub-Worker state (busy / idle / 미연결) → gates `requires_sub_worker_*`
 *   3. Time window (morning / afternoon / evening / night) → gates `time_window`
 *
 * The scenario lives in the editor's local state and is read by the
 * phase view to compute effective firing probabilities. Operators
 * can switch scenarios to verify "if Sub-Worker is busy AND it's
 * afternoon, what fires?" without running the agent.
 */

import {
  Coffee,
  Moon,
  Sun,
  Sunrise,
  Sunset,
} from 'lucide-react';

import type {
  RuntimeScenario,
  SubWorkerState,
} from './triggerSimulator';
import type { TimeWindow } from '@/types/triggerPreset';

const SUB_WORKER_OPTIONS: {
  value: SubWorkerState;
  label: string;
  hint: string;
}[] = [
  {
    value: 'idle',
    label: 'idle',
    hint: 'Sub-Worker가 연결되어 있고 작업 중이 아님',
  },
  {
    value: 'busy',
    label: 'busy',
    hint: 'Sub-Worker가 작업 처리 중',
  },
  {
    value: 'unlinked',
    label: '미연결',
    hint: 'Sub-Worker 페어링 없음',
  },
];

const TIME_OPTIONS: {
  value: TimeWindow;
  label: string;
  icon: typeof Sun;
}[] = [
  { value: 'morning', label: '아침', icon: Sunrise },
  { value: 'afternoon', label: '오후', icon: Sun },
  { value: 'evening', label: '저녁', icon: Sunset },
  { value: 'night', label: '밤', icon: Moon },
];

export interface ScenarioBarProps {
  scenario: RuntimeScenario;
  onChange: (next: RuntimeScenario) => void;
  /**
   * Phases in the manifest, used to suggest sensible consec count
   * values quickly (e.g., the lower bound of each phase).
   */
  phaseShortcuts?: { label: string; consecutive: number }[];
}

export default function ScenarioBar({
  scenario,
  onChange,
  phaseShortcuts,
}: ScenarioBarProps) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Coffee className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
        <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
          시나리오 시뮬레이터
        </span>
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          · 아래 페이즈의 비율은 이 시나리오 기준으로 표시됩니다
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Consec count */}
        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))]">
            연속 트리거 횟수
          </label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              step={1}
              value={scenario.consecutive}
              onChange={(e) => {
                const n = Math.max(0, Math.round(Number(e.target.value)));
                if (Number.isFinite(n))
                  onChange({ ...scenario, consecutive: n });
              }}
              className="h-8 px-2 w-20 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-center"
            />
            {phaseShortcuts && phaseShortcuts.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {phaseShortcuts.map((s) => (
                  <button
                    key={s.label + s.consecutive}
                    type="button"
                    onClick={() =>
                      onChange({ ...scenario, consecutive: s.consecutive })
                    }
                    className={`h-7 px-2 rounded text-[0.7rem] font-medium border transition-colors ${
                      scenario.consecutive === s.consecutive
                        ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
                        : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                    }`}
                    title={`${s.label} (${s.consecutive}회)`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sub-Worker state */}
        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))]">
            Sub-Worker 상태
          </label>
          <div className="flex items-center gap-1">
            {SUB_WORKER_OPTIONS.map((opt) => {
              const active = scenario.subWorker === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ ...scenario, subWorker: opt.value })}
                  title={opt.hint}
                  className={`h-8 px-2.5 rounded-md text-[0.75rem] font-medium border transition-colors ${
                    active
                      ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Screen sharing */}
        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))]">
            화면 공유
          </label>
          <button
            type="button"
            onClick={() =>
              onChange({ ...scenario, screenActive: !scenario.screenActive })
            }
            title="켜면 화면 관찰(requires_screen_active) 상황이 발사 가능해집니다"
            className={`h-8 px-2.5 rounded-md text-[0.75rem] font-medium border transition-colors ${
              scenario.screenActive
                ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
                : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
            }`}
          >
            {scenario.screenActive ? '공유 중' : '꺼짐'}
          </button>
        </div>

        {/* Time window */}
        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))]">
            현재 시간대
          </label>
          <div className="flex items-center gap-1">
            {TIME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = scenario.timeWindow === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    onChange({ ...scenario, timeWindow: opt.value })
                  }
                  className={`h-8 px-2.5 rounded-md text-[0.75rem] font-medium border transition-colors inline-flex items-center gap-1.5 ${
                    active
                      ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
