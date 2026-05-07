'use client';

/**
 * ConditionsEditor — fire-time condition gates for one trigger.
 *
 * Mirrors the backend's :class:`CategoryConditions` schema:
 *
 *   - sub-worker busy / idle requirement
 *   - time-of-day window
 *   - consecutive-trigger bounds (min / max)
 *   - per-trigger cooldown (lives on the category, not the conditions
 *     dict, but presented inline because it's visually a "gate" too)
 */

import type { CategoryConditions, TimeWindow } from '@/types/triggerPreset';

const INPUT_SM =
  'h-8 px-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';

const TIME_WINDOWS: { value: TimeWindow | ''; label: string }[] = [
  { value: '', label: '제한 없음' },
  { value: 'morning', label: '아침' },
  { value: 'afternoon', label: '오후' },
  { value: 'evening', label: '저녁' },
  { value: 'night', label: '밤' },
];

export interface ConditionsEditorProps {
  conditions: CategoryConditions;
  cooldownSeconds: number;
  onConditions: (next: CategoryConditions) => void;
  onCooldown: (next: number) => void;
}

export default function ConditionsEditor({
  conditions,
  cooldownSeconds,
  onConditions,
  onCooldown,
}: ConditionsEditorProps) {
  const set = (patch: Partial<CategoryConditions>) =>
    onConditions({ ...conditions, ...patch });

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
        발사 조건
      </span>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CheckboxField
          label="Sub-Worker가 작업 중일 때만"
          checked={!!conditions.requires_sub_worker_busy}
          onChange={(v) =>
            set({ requires_sub_worker_busy: v || undefined })
          }
        />
        <CheckboxField
          label="Sub-Worker가 idle일 때만"
          checked={!!conditions.requires_sub_worker_idle}
          onChange={(v) =>
            set({ requires_sub_worker_idle: v || undefined })
          }
        />

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            시간대 제한
          </label>
          <select
            value={conditions.time_window ?? ''}
            onChange={(e) =>
              set({
                time_window: (e.target.value || null) as TimeWindow | null,
              })
            }
            className={INPUT_SM}
          >
            {TIME_WINDOWS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            쿨다운 (초)
          </label>
          <input
            type="number"
            value={cooldownSeconds}
            min={0}
            step={5}
            onChange={(e) => {
              const n = Math.max(0, Number(e.target.value));
              if (Number.isFinite(n)) onCooldown(n);
            }}
            className={INPUT_SM}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            최소 연속 트리거 (옵션)
          </label>
          <input
            type="number"
            value={conditions.min_consecutive ?? ''}
            min={0}
            step={1}
            onChange={(e) => {
              const raw = e.target.value;
              set({
                min_consecutive: raw === '' ? null : Math.max(0, Number(raw)),
              });
            }}
            placeholder="제한 없음"
            className={INPUT_SM}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            최대 연속 트리거 (옵션)
          </label>
          <input
            type="number"
            value={conditions.max_consecutive ?? ''}
            min={0}
            step={1}
            onChange={(e) => {
              const raw = e.target.value;
              set({
                max_consecutive: raw === '' ? null : Math.max(0, Number(raw)),
              });
            }}
            placeholder="제한 없음"
            className={INPUT_SM}
          />
        </div>
      </div>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 accent-violet-500"
      />
      <span className="text-[0.8125rem] text-[hsl(var(--foreground))]">
        {label}
      </span>
    </label>
  );
}
