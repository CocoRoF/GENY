'use client';

/**
 * PhaseEditor — single phase row inside :mod:`TriggerPresetEditor`.
 *
 * A phase is a consecutive-trigger-count bracket plus a weighted
 * roulette table. The UI lets the operator:
 *
 *   - Edit the bracket (min / max, with max=null = open-ended top)
 *   - Reorder phases (↑/↓ within parent)
 *   - Add or remove events (one row per category)
 *   - Adjust each event's weight
 *
 * Cycle 20260507 — the row table now surfaces the *runtime contract*
 * directly:
 *
 *   • Each event row pulls the linked category's condition gates
 *     (sub-worker state, time window, consec bounds, cooldown) and
 *     renders them as inline chips.
 *   • The "비율" column reflects the **effective probability under
 *     the current scenario**, not the raw weight share. Events whose
 *     conditions don't pass under the scenario are dimmed and tagged
 *     with a "차단됨: <reason>" chip.
 *   • A footer line shows the active vs. blocked weight totals so
 *     operators see *why* the visible percentages don't sum to the
 *     raw weights.
 *
 * The raw weight stays editable because that's the data model's
 * source of truth — only the rendered probability column tracks the
 * scenario. Switch the scenario in :mod:`ScenarioBar` to compare.
 */

import { useMemo } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CircleSlash,
  Lock,
  Trash2,
  X,
} from 'lucide-react';

import type {
  PhaseEvent,
  TriggerCategory,
  TriggerPhase,
} from '@/types/triggerPreset';

import {
  describeConditions,
  type RuntimeScenario,
  type SimulatedEvent,
  simulatePhase,
} from './triggerSimulator';
import type { TriggerPresetManifest } from '@/types/triggerPreset';

const INPUT_SM =
  'h-7 px-2 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';

const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

export interface PhaseEditorProps {
  phase: TriggerPhase;
  categories: TriggerCategory[];
  /** Live manifest — used for the simulator's reverse lookups. */
  manifest: TriggerPresetManifest;
  /** Active scenario; drives effective % column. */
  scenario: RuntimeScenario;
  isFirst: boolean;
  isLast: boolean;
  onPatch: (patch: Partial<TriggerPhase>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetEvents: (events: PhaseEvent[]) => void;
  /** Click-through to jump to the categories section. */
  onJumpToCategory?: (categoryId: string) => void;
}

export default function PhaseEditor({
  phase,
  categories,
  manifest,
  scenario,
  isFirst,
  isLast,
  onPatch,
  onRemove,
  onMoveUp,
  onMoveDown,
  onSetEvents,
  onJumpToCategory,
}: PhaseEditorProps) {
  const referencedIds = useMemo(
    () => new Set(phase.events.map((e) => e.category_id)),
    [phase.events],
  );
  const availableCategories = useMemo(
    () => categories.filter((c) => !referencedIds.has(c.id)),
    [categories, referencedIds],
  );

  // Run the simulator once per render — pure function, cheap.
  const simulation = useMemo(
    () => simulatePhase(phase, manifest, scenario),
    [phase, manifest, scenario],
  );

  const totalWeightRaw = phase.events.reduce(
    (sum, e) => sum + Math.max(0, e.weight),
    0,
  );

  const updateEvent = (
    categoryId: string,
    patch: Partial<PhaseEvent>,
  ) => {
    onSetEvents(
      phase.events.map((e) =>
        e.category_id === categoryId ? { ...e, ...patch } : e,
      ),
    );
  };

  const removeEvent = (categoryId: string) => {
    onSetEvents(phase.events.filter((e) => e.category_id !== categoryId));
  };

  const addEvent = (categoryId: string) => {
    if (!categoryId) return;
    if (referencedIds.has(categoryId)) return;
    onSetEvents([...phase.events, { category_id: categoryId, weight: 1 }]);
  };

  const handleMaxChange = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.toLowerCase() === '∞') {
      onPatch({ max_consecutive: null });
      return;
    }
    const n = Math.max(0, Math.round(Number(trimmed)));
    if (Number.isFinite(n)) onPatch({ max_consecutive: n });
  };

  const phaseMatches = simulation.matchesScenario;

  return (
    <div
      className={`rounded-lg border bg-[hsl(var(--background))] p-4 flex flex-col gap-3 ${
        phaseMatches
          ? 'border-violet-500/40 ring-1 ring-violet-500/20'
          : 'border-[hsl(var(--border))]'
      }`}
    >
      {/* ── Phase header ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] uppercase tracking-wider font-semibold ${
            phaseMatches
              ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
              : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'
          }`}
        >
          {phaseMatches ? '활성' : '비활성'}
        </span>
        <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
          페이즈
        </span>
        <input
          type="text"
          value={phase.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="페이즈 이름"
          className={`${INPUT_SM} flex-1 min-w-[160px]`}
        />
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          연속 트리거
        </span>
        <input
          type="number"
          value={phase.min_consecutive}
          min={0}
          step={1}
          onChange={(e) =>
            onPatch({
              min_consecutive: Math.max(
                0,
                Math.round(Number(e.target.value)),
              ),
            })
          }
          className={`${INPUT_SM} w-16 text-center`}
        />
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          ~
        </span>
        <input
          type="text"
          value={phase.max_consecutive ?? '∞'}
          onChange={(e) => handleMaxChange(e.target.value)}
          className={`${INPUT_SM} w-16 text-center`}
          title="비워두거나 ∞ 입력 시 상한 없음"
        />
        <div className="flex-1 min-w-0" />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            className={ICON_BTN}
            title="위로"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            className={ICON_BTN}
            title="아래로"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
            title="페이즈 삭제"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Active-scenario banner ── */}
      <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] flex items-center gap-2 flex-wrap">
        <span>
          현재 시나리오 <span className="font-mono">consec={scenario.consecutive}</span>{' '}
          {phaseMatches ? (
            <span className="text-violet-600 dark:text-violet-300 font-medium">
              → 이 페이즈가 매칭됩니다
            </span>
          ) : (
            <span>→ 다른 페이즈가 매칭됩니다</span>
          )}
        </span>
      </div>

      {/* ── Event matrix ── */}
      {phase.events.length === 0 ? (
        <div className="rounded border border-dashed border-[hsl(var(--border))] px-3 py-4 text-center text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          이 페이즈는 아직 이벤트가 없어 발화하지 않습니다. 아래에서 카테고리를
          추가하세요.
        </div>
      ) : (
        <div className="rounded-md border border-[hsl(var(--border))] divide-y divide-[hsl(var(--border))]">
          <div className="grid grid-cols-[1.4fr_120px_120px_28px] items-center gap-2 px-3 py-1.5 text-[0.65rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold bg-[hsl(var(--muted)/0.4)]">
            <span>카테고리 + 발사 조건</span>
            <span className="text-right">가중치</span>
            <span className="text-right">현재 시나리오 비율</span>
            <span />
          </div>
          {simulation.events.map((sim) => (
            <EventRow
              key={sim.event.category_id}
              sim={sim}
              onWeight={(w) => updateEvent(sim.event.category_id, { weight: w })}
              onRemove={() => removeEvent(sim.event.category_id)}
              onJumpToCategory={onJumpToCategory}
            />
          ))}
          <FooterLine
            simulation={simulation}
            totalWeightRaw={totalWeightRaw}
          />
        </div>
      )}

      {/* ── Add event ── */}
      {availableCategories.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            defaultValue=""
            onChange={(e) => {
              addEvent(e.target.value);
              e.currentTarget.value = '';
            }}
            className={`${INPUT_SM} flex-1`}
          >
            <option value="" disabled>
              + 카테고리 선택해 추가
            </option>
            {availableCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || c.id} ({c.kind})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// ── Event row ──────────────────────────────────────────────────

interface EventRowProps {
  sim: SimulatedEvent;
  onWeight: (w: number) => void;
  onRemove: () => void;
  onJumpToCategory?: (categoryId: string) => void;
}

function EventRow({ sim, onWeight, onRemove, onJumpToCategory }: EventRowProps) {
  const cat = sim.category;
  const blocked = sim.blocked;
  const conditionChips = cat ? describeConditions(cat) : [];

  return (
    <div
      className={`grid grid-cols-[1.4fr_120px_120px_28px] items-start gap-2 px-3 py-2.5 ${
        blocked ? 'opacity-60' : ''
      }`}
    >
      {/* Category column */}
      <div className="min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={
              onJumpToCategory && cat
                ? () => onJumpToCategory(cat.id)
                : undefined
            }
            disabled={!onJumpToCategory || !cat}
            className={`text-[0.8125rem] font-medium text-[hsl(var(--foreground))] truncate text-left ${
              onJumpToCategory && cat
                ? 'hover:text-violet-600 dark:hover:text-violet-300 hover:underline'
                : 'cursor-default'
            }`}
            title={cat ? '카테고리 정의로 이동' : undefined}
          >
            {cat?.label || sim.event.category_id}
          </button>
          {cat?.kind && (
            <span className="inline-block px-1 rounded text-[0.6rem] uppercase tracking-wider bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
              {cat.kind}
            </span>
          )}
          {!cat && (
            <span className="text-[0.6875rem] text-amber-600">
              (없는 카테고리)
            </span>
          )}
        </div>
        <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] font-mono truncate">
          {sim.event.category_id}
        </div>

        {/* Condition chips */}
        {conditionChips.length === 0 && cat ? (
          <div className="text-[0.65rem] text-[hsl(var(--muted-foreground))] italic">
            조건 없음 — 이 페이즈가 매칭되면 항상 후보
          </div>
        ) : (
          conditionChips.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {conditionChips.map((chip, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.65rem] font-medium ${
                    chip.tone === 'warn'
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                      : chip.tone === 'info'
                        ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30'
                        : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))]'
                  }`}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          )
        )}

        {/* Blocked reason */}
        {blocked && (
          <div className="inline-flex items-center gap-1 text-[0.65rem] text-red-600 dark:text-red-400 mt-0.5">
            {blocked.code === 'unknown_category' ? (
              <Lock className="w-3 h-3" />
            ) : (
              <CircleSlash className="w-3 h-3" />
            )}
            <span>차단됨 — {blocked.message}</span>
          </div>
        )}
      </div>

      {/* Weight input */}
      <div className="flex justify-end pt-0.5">
        <input
          type="number"
          value={sim.event.weight}
          min={0}
          step={1}
          onChange={(e) => {
            const n = Math.max(0, Number(e.target.value));
            if (Number.isFinite(n)) onWeight(n);
          }}
          className={`${INPUT_SM} text-right tabular-nums w-24`}
        />
      </div>

      {/* Effective % */}
      <div className="text-right pt-2 tabular-nums">
        {blocked ? (
          <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
            —
          </span>
        ) : (
          <span className="text-[0.8125rem] font-semibold text-violet-700 dark:text-violet-300">
            {sim.effectivePct.toFixed(1)}%
          </span>
        )}
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        className={`${ICON_BTN} mt-1 hover:!text-red-500 hover:!bg-red-500/10`}
        title="이벤트 제거"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Footer line ────────────────────────────────────────────────

function FooterLine({
  simulation,
  totalWeightRaw,
}: {
  simulation: ReturnType<typeof simulatePhase>;
  totalWeightRaw: number;
}) {
  const eligibleCount = simulation.events.filter((e) => !e.blocked).length;
  const blockedCount = simulation.events.length - eligibleCount;

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[hsl(var(--muted)/0.25)] text-[0.7rem] text-[hsl(var(--muted-foreground))]">
      <div className="flex items-center gap-3 flex-wrap">
        <span>
          전체 가중치{' '}
          <span className="tabular-nums font-semibold text-[hsl(var(--foreground))]">
            {totalWeightRaw.toFixed(0)}
          </span>
        </span>
        <span className="text-[hsl(var(--muted-foreground))]">·</span>
        <span>
          시나리오 활성 가중치{' '}
          <span className="tabular-nums font-semibold text-violet-700 dark:text-violet-300">
            {simulation.effectiveTotalWeight.toFixed(0)}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-2 text-[0.7rem]">
        <span className="text-emerald-700 dark:text-emerald-300">
          활성 {eligibleCount}
        </span>
        {blockedCount > 0 && (
          <span className="text-red-600 dark:text-red-400">
            차단 {blockedCount}
          </span>
        )}
      </div>
    </div>
  );
}
